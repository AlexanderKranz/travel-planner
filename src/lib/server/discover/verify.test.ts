import { describe, expect, it, vi } from "vitest";
import type { MonthlyClimate, PlaceCandidate } from "@/lib/domain/facts";
import type { GeoPlace } from "@/lib/domain/geo";
import type { CachedResult } from "../api-cache";
import type { Idea } from "../ai/destination-ideas";
import { MAX_CLIMATE_MISSES, verifyIdeas, VERIFY_BUDGET_MS, type VerifyDeps, type VerifyInput } from "./verify";

vi.mock("server-only", () => ({}));

// ---- fixtures ----
const PLACES: Record<string, GeoPlace> = {
  Marbella: { geoId: 2513918, name: "Marbella", featureCode: "PPLA3", countryCode: "ES", admin1: "Andalusia", lat: 36.51, lon: -4.88, timezone: "Europe/Madrid", population: 141000, suggestedKind: "city" },
  Palma: { geoId: 2512989, name: "Palma", featureCode: "PPLA", countryCode: "ES", admin1: "Balearic Islands", lat: 39.57, lon: 2.65, timezone: "Europe/Madrid", population: 400000, suggestedKind: "city" },
  Málaga: { geoId: 2514256, name: "Málaga", featureCode: "PPLA2", countryCode: "ES", admin1: "Andalusia", lat: 36.72, lon: -4.42, timezone: "Europe/Madrid", population: 570000, suggestedKind: "city" },
  Fuengirola: { geoId: 2517117, name: "Fuengirola", featureCode: "PPL", countryCode: "ES", admin1: "Andalusia", lat: 36.54, lon: -4.62, timezone: "Europe/Madrid", population: 80000, suggestedKind: "city" },
  Faro: { geoId: 2268337, name: "Faro", featureCode: "PPLA", countryCode: "PT", admin1: "Faro", lat: 37.02, lon: -7.93, timezone: "Europe/Lisbon", population: 60000, suggestedKind: "city" },
  Lisboa: { geoId: 2267057, name: "Lisboa", featureCode: "PPLC", countryCode: "PT", admin1: "Lisbon", lat: 38.72, lon: -9.14, timezone: "Europe/Lisbon", population: 500000, suggestedKind: "city" },
  Passau: { geoId: 2855328, name: "Passau", featureCode: "PPL", countryCode: "DE", admin1: "Bavaria", lat: 48.57, lon: 13.46, timezone: "Europe/Berlin", population: 50000, suggestedKind: "city" },
};
const idea = (anchor: string, over: Partial<Idea> = {}): Idea => ({ name: anchor, anchor, cc: PLACES[anchor]?.countryCode ?? "ES", reason: "Schöne Plätze", ...over });
const month = (m: number, tMaxC: number, tMinC: number, wetDays: number): MonthlyClimate => ({ month: m, tMaxC, tMinC, precipMm: 40, wetDays, sunshineHours: 6 });
const climateYear = (tMaxC: number, tMinC: number, wetDays: number) => Array.from({ length: 12 }, (_, i) => month(i + 1, tMaxC, tMinC, wetDays));
const candidates = (n: number): PlaceCandidate[] =>
  Array.from({ length: n }, (_, i) => ({ osmType: "way", osmId: i + 1, name: `P${i}`, names: {}, category: "leisure=golf_course", lat: 0, lon: 0, distanceKm: 5, osmUrl: "https://osm.org/way/1" }));
const ok = <T,>(data: T, over: Partial<{ stale: boolean }> = {}): CachedResult<T> => ({ ok: true, data, fetchedAt: "2026-11-01T10:00:00.000Z", stale: over.stale ?? false, cache: "miss" });
const bad = (error: "provider_error" | "timeout" | "quota_exhausted" = "provider_error"): CachedResult<never> => ({ ok: false, error });

type Mocks = { [K in keyof VerifyDeps]: ReturnType<typeof vi.fn> } & VerifyDeps;
function deps(over: Partial<VerifyDeps> = {}): Mocks {
  const d: VerifyDeps = {
    geocode: vi.fn(async (anchor: string) => {
      const p = PLACES[anchor];
      return ok(p ? [p] : []);
    }),
    climate: vi.fn(async () => ok(climateYear(20, 10, 5))),
    pois: vi.fn(async (interest) => ({ radiusKm: 40, result: ok(candidates(interest === "golf" ? 6 : 3)) })),
    driveRoute: vi.fn(async () => bad()),
    placeById: vi.fn(async () => null),
    now: () => 0,
    ...over,
  };
  return d as Mocks;
}

const base = (over: Partial<VerifyInput> = {}): VerifyInput => ({
  ideas: [idea("Marbella", { name: "Costa del Sol" })],
  round: 1,
  lang: "de",
  userId: "u1",
  today: "2026-11-01",
  months: [3],
  origins: ["FRA"],
  maxHours: 3,
  interests: ["golf"],
  existing: [],
  ...over,
});

describe("verifyIdeas: cards", () => {
  it("E1/E5: Costa del Sol / Marbella is a region around the anchor, Faro a city; each shows its estimate, climate and golf count", async () => {
    const out = await verifyIdeas(base({ ideas: [idea("Marbella", { name: "Costa del Sol" }), idea("Faro", { name: "Algarve" })] }), deps());
    expect(out.cards.map((c) => [c.name, c.kind, c.placeName, c.geoId])).toEqual([
      ["Costa del Sol", "region", "Marbella", 2513918],
      ["Algarve", "region", "Faro", 2268337],
    ]);
    const c = out.cards[0];
    expect(c).toMatchObject({ id: "g2513918", round: 1, countryCode: "ES", admin1: "Andalusia", nearAirport: false });
    expect(c.place).toEqual({ source: "geonames", fetchedAt: "2026-11-01T10:00:00.000Z", stale: false });
    expect(c.flight).toMatchObject({ origin: "FRA" });
    expect(c.climate).toMatchObject({ status: "ok", source: "open_meteo", period: { from: 2016, to: 2025 } });
    expect(c.climate && c.climate.status === "ok" && c.climate.months.map((m) => m.month)).toEqual([3]);
    expect(c.pois).toEqual([{ status: "ok", interest: "golf", count: 6, radiusKm: 40, source: "osm", fetchedAt: "2026-11-01T10:00:00.000Z", stale: false }]);
    expect(out.drops).toEqual({});
  });

  it("E5: a city idea whose name equals the anchor is kind city; Mallorca / Palma is a region", async () => {
    const out = await verifyIdeas(base({ ideas: [idea("Palma", { name: "Mallorca" }), idea("Málaga")], maxHours: 3 }), deps());
    expect(out.cards.map((c) => c.kind)).toEqual(["region", "city"]);
  });

  it("E2: 2 h from FRA drops Malaga as too_far and keeps Mallorca (the estimate stays under the limit)", async () => {
    const out = await verifyIdeas(base({ ideas: [idea("Málaga"), idea("Palma", { name: "Mallorca" })], maxHours: 2 }), deps());
    expect(out.drops).toEqual({ too_far: 1 });
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0].flight).toMatchObject({ origin: "FRA", gateway: "PMI", minutes: 124 });
  });

  it("falls back to the display name when a local-only anchor is not found", async () => {
    const lisbon = { ...PLACES.Faro, geoId: 2267057, name: "Lissabon", featureCode: "PPLC" };
    const geocode = vi.fn<VerifyDeps["geocode"]>(async (query) => ok(query === "Lissabon" ? [lisbon] : []));
    const out = await verifyIdeas(base({ ideas: [idea("Lisboa", { name: "Lissabon", cc: "PT" })] }), deps({ geocode }));
    expect(out.cards.map((c) => [c.geoId, c.kind])).toEqual([[2267057, "city"]]);
    expect(geocode.mock.calls.map((c) => [c[0], c[1]])).toEqual([["Lisboa", "en"], ["Lisboa", "de"], ["Lissabon", "de"]]);
  });

  it("makes no third lookup when the name equals the anchor, and the fallback keeps the country check", async () => {
    const geocode = vi.fn(async () => ok([]));
    const same = await verifyIdeas(base({ ideas: [idea("Nirgendwo")] }), deps({ geocode }));
    expect(same.drops).toEqual({ not_found: 1 });
    expect(geocode).toHaveBeenCalledTimes(2);
    const elsewhere = { ...PLACES.Faro, name: "Lissabon", countryCode: "US" };
    const wrong = await verifyIdeas(
      base({ ideas: [idea("Lisboa", { name: "Lissabon", cc: "PT" })] }),
      deps({ geocode: vi.fn(async (q: string) => ok(q === "Lissabon" ? [elsewhere] : [])) }),
    );
    expect(wrong.cards).toEqual([]);
    expect(wrong.drops).toEqual({ not_found: 1 });
  });

  it("E5: a wrong country code drops the idea as not_found", async () => {
    const out = await verifyIdeas(base({ ideas: [idea("Lisboa", { cc: "ES" })] }), deps());
    expect(out.cards).toEqual([]);
    expect(out.drops).toEqual({ not_found: 1 });
  });

  it("E7: all ideas outside the radius -> 0 cards, counts present, nothing else was looked up", async () => {
    const d = deps();
    const out = await verifyIdeas(base({ ideas: [idea("Málaga"), idea("Faro"), idea("Lisboa")], maxHours: 1.5 }), d);
    expect(out.cards).toEqual([]);
    expect(out.drops).toEqual({ too_far: 3 });
    expect(out.geocodeDown).toBe(false);
    expect(d.climate).not.toHaveBeenCalled();
    expect(d.pois).not.toHaveBeenCalled();
  });

  it("duplicate: the same place twice, or two places within 30 km, keep only the first", async () => {
    const out = await verifyIdeas(base({ ideas: [idea("Marbella"), idea("Fuengirola"), idea("Marbella", { name: "Costa" })] }), deps());
    expect(out.cards.map((c) => c.placeName)).toEqual(["Marbella"]);
    expect(out.drops).toEqual({ duplicate: 2 });
  });

  it("round 2 excludes places already on the list (by geoId)", async () => {
    const out = await verifyIdeas(base({ round: 2, ideas: [idea("Marbella"), idea("Palma")], existing: [{ geoId: 2513918 }] }), deps());
    expect(out.cards.map((c) => c.placeName)).toEqual(["Palma"]);
    expect(out.cards[0].round).toBe(2);
    expect(out.drops).toEqual({ duplicate: 1 });
  });

  it("E6: a reason with a banned fact is removed, the verified card stays; clean reasons stay", async () => {
    const out = await verifyIdeas(
      base({
        ideas: [idea("Marbella", { reason: "Nur 2 h Flug, ab 49 €, 30 km zum Platz" }), idea("Palma", { reason: "Schöne Ausflüge" })],
      }),
      deps(),
    );
    expect(out.cards.map((c) => c.reason)).toEqual([null, "Schöne Ausflüge"]);
    expect(out.reasonsRemoved).toBe(1);
  });
});

describe("verifyIdeas: a failure is not a negative result (D7)", () => {
  it("geocoding down for every idea: nothing can be shown", async () => {
    const out = await verifyIdeas(base({ ideas: [idea("Marbella"), idea("Palma")] }), deps({ geocode: vi.fn(async () => bad()) }));
    expect(out).toMatchObject({ cards: [], geocodeDown: true });
  });

  it("geocoding failed for one idea: it cannot be shown, but it is counted apart from not_found", async () => {
    const geocode = vi.fn(async (a: string) => (a === "Palma" ? bad("timeout") : ok([PLACES[a]])));
    const out = await verifyIdeas(base({ ideas: [idea("Marbella"), idea("Palma")] }), deps({ geocode }));
    expect(out.geocodeDown).toBe(false);
    expect(out.cards).toHaveLength(1);
    expect(out.drops).toEqual({ geocode_failed: 1 });
  });

  it("a zero-result geocode is a real negative: not_found", async () => {
    const out = await verifyIdeas(base({ ideas: [idea("Nowhereville", { cc: "ES" })] }), deps());
    expect(out.drops).toEqual({ not_found: 1 });
    expect(out.geocodeDown).toBe(false);
  });

  it("climate provider failed: the card stays with 'not checked'", async () => {
    const out = await verifyIdeas(base(), deps({ climate: vi.fn(async () => bad()) }));
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0].climate).toEqual({ status: "not_checked" });
    expect(out.drops).toEqual({});
  });

  it("climate real negative drops the card (golf in a cold wet month) before any POI lookup", async () => {
    const d = deps({ climate: vi.fn(async () => ok(climateYear(5, 0, 18))) });
    const out = await verifyIdeas(base(), d);
    expect(out.cards).toEqual([]);
    expect(out.drops).toEqual({ climate: 1 });
    expect(d.pois).not.toHaveBeenCalled(); // cheapest step first: no Geoapify credits for a card that is out anyway
  });

  it("POI provider, quota or no key: 'not checked', the card stays", async () => {
    for (const fail of [bad("provider_error"), bad("quota_exhausted"), bad("timeout")]) {
      const out = await verifyIdeas(base(), deps({ pois: vi.fn(async () => ({ radiusKm: 40, result: fail })) }));
      expect(out.cards).toHaveLength(1);
      expect(out.cards[0].pois).toEqual([{ status: "not_checked", interest: "golf" }]);
    }
    const none = await verifyIdeas(base(), deps({ pois: vi.fn(async () => null) }));
    expect(none.cards[0].pois).toEqual([{ status: "not_checked", interest: "golf" }]);
  });

  it("POI real negative: golf with 1 course (min 2) drops, 2 stays", async () => {
    const one = await verifyIdeas(base(), deps({ pois: vi.fn(async () => ({ radiusKm: 40, result: ok(candidates(1)) })) }));
    expect(one.drops).toEqual({ no_poi: 1 });
    expect(one.cards).toEqual([]);
    const two = await verifyIdeas(base(), deps({ pois: vi.fn(async () => ({ radiusKm: 40, result: ok(candidates(2)) })) }));
    expect(two.cards).toHaveLength(1);
    expect(two.cards[0].pois[0]).toMatchObject({ status: "ok", count: 2 });
  });

  it("an empty but successful result is cached data, not a failure: beach with 0 matches drops", async () => {
    const out = await verifyIdeas(base({ interests: ["beach"], months: [] }), deps({ pois: vi.fn(async () => ({ radiusKm: 15, result: ok([]) })) }));
    expect(out.drops).toEqual({ no_poi: 1 });
  });

  it("'almost everywhere' interests show the count and never drop, even at 0", async () => {
    const out = await verifyIdeas(base({ interests: ["museums"] }), deps({ pois: vi.fn(async () => ({ radiusKm: 15, result: ok([]) })) }));
    expect(out.cards[0].pois).toEqual([expect.objectContaining({ status: "ok", interest: "museums", count: 0 })]);
  });

  it("a stale cached result is used and flagged", async () => {
    const out = await verifyIdeas(base(), deps({ pois: vi.fn(async () => ({ radiusKm: 40, result: ok(candidates(5), { stale: true }) })) }));
    expect(out.cards[0].pois[0]).toMatchObject({ status: "ok", stale: true });
  });
});

describe("verifyIdeas: optional context (D1)", () => {
  it("E3: cruise with a toddler, December, no airports: no flight lines, cruise and christmas markets 'not checked', no POI lookups", async () => {
    const d = deps();
    const out = await verifyIdeas(base({ ideas: [idea("Passau")], months: [12], origins: [], maxHours: null, interests: ["cruise", "christmas_markets"] }), d);
    const c = out.cards[0];
    expect(c.flight).toBeNull();
    expect(c.nearAirport).toBe(false);
    expect(c.pois).toEqual([
      { status: "not_checked", interest: "cruise" },
      { status: "not_checked", interest: "christmas_markets" },
    ]);
    expect(c.climate).toMatchObject({ status: "ok" });
    expect(d.pois).not.toHaveBeenCalled();
  });

  it("E4: 'relaxing' with no interest key, no month, no airports: nothing is checked, nothing is dropped", async () => {
    const d = deps();
    const out = await verifyIdeas(base({ months: [], origins: [], maxHours: null, interests: [] }), d);
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]).toMatchObject({ climate: null, pois: [], flight: null });
    expect(d.climate).not.toHaveBeenCalled();
    expect(d.pois).not.toHaveBeenCalled();
    expect(out.drops).toEqual({});
  });

  it("no month: no climate lookup and the card has no climate block (null)", async () => {
    const d = deps();
    const out = await verifyIdeas(base({ months: [] }), d);
    expect(out.cards[0].climate).toBeNull();
    expect(d.climate).not.toHaveBeenCalled();
  });

  it("at most 2 interests are looked up, those with a POI check first", async () => {
    const d = deps();
    await verifyIdeas(base({ interests: ["christmas_markets", "city_sightseeing", "golf", "museums"] }), d);
    expect(d.pois.mock.calls.map((c) => c[0]).sort()).toEqual(["city_sightseeing", "golf"]);
  });

  it("slow OSM interests (skiing) are cache-only: networkAllowed is false", async () => {
    const d = deps();
    await verifyIdeas(base({ ideas: [idea("Marbella")], interests: ["skiing"], months: [] }), d);
    expect(d.pois).toHaveBeenCalledWith("skiing", expect.anything(), 15, expect.anything(), false);
    const d2 = deps();
    await verifyIdeas(base({ interests: ["golf"], months: [] }), d2);
    expect(d2.pois).toHaveBeenCalledWith("golf", expect.anything(), 40, expect.anything(), true);
  });

  it("POI radius base is the kind's default (region 40, city 15), the same as a trip made from the card", async () => {
    const d = deps();
    await verifyIdeas(base({ ideas: [idea("Marbella", { name: "Costa del Sol" }), idea("Faro")], interests: ["museums"], months: [] }), d);
    expect(d.pois.mock.calls.map((c) => c[2])).toEqual([40, 15]);
  });
});

describe("verifyIdeas: cold search limits (D9)", () => {
  const eight = ["Marbella", "Palma", "Málaga", "Faro", "Lisboa", "Passau", "Fuengirola"].map((a) => idea(a));

  it("stops at 5 cards: later ideas are not verified", async () => {
    const places = { ...PLACES, A1: { ...PLACES.Passau, geoId: 9001, name: "A1", lat: 10, lon: 10 }, A2: { ...PLACES.Passau, geoId: 9002, name: "A2", lat: 20, lon: 20 }, A3: { ...PLACES.Passau, geoId: 9003, name: "A3", lat: 30, lon: 30 } };
    const ideas = ["Marbella", "Palma", "Faro", "Lisboa", "Passau", "A1", "A2", "A3"].map((a) => idea(a, { cc: places[a as keyof typeof places].countryCode ?? "ES" }));
    const d = deps({ geocode: vi.fn(async (a: string) => ok([places[a as keyof typeof places]])) });
    const out = await verifyIdeas(base({ ideas, origins: [], maxHours: null }), d);
    expect(out.cards.map((c) => c.placeName)).toEqual(["Marbella", "Palma", "Faro", "Lisboa", "Passau"]);
    // concurrency 2 can start one extra lookup, never the whole tail
    expect(d.climate.mock.calls.length).toBeLessThanOrEqual(6);
    expect(d.climate.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  const manyPlaces = (n: number): GeoPlace[] => Array.from({ length: n }, (_, i) => ({ ...PLACES.Passau, geoId: 7000 + i, lat: 10 + i * 5, lon: 10 }));
  const nth = (n: number) => Array.from({ length: n }, (_, i) => idea("Passau", { name: `X${i}` }));

  it("at most 5 climate cache misses per search: the 6th is refused through fetchAllowed and that place is not shown", async () => {
    let attempts = 0;
    const climate = vi.fn(async (_p: unknown, _c: unknown, fetchAllowed: () => boolean) => {
      // every lookup is a cache miss and wants the network
      attempts += 1;
      return fetchAllowed() ? ok(climateYear(5, 0, 18)) /* cold: golf fails */ : bad("timeout");
    });
    const places = manyPlaces(8);
    const d = deps({ geocode: vi.fn(async () => ok([places.shift()!])), climate });
    const out = await verifyIdeas(base({ ideas: nth(8), origins: [], maxHours: null }), d);
    expect(MAX_CLIMATE_MISSES).toBe(5);
    expect(attempts).toBe(8); // the cap stops network misses, not the walk over the places
    expect(out.climateMisses).toBe(5);
    expect(out.drops).toEqual({ climate: 5 });
    expect(out.cards).toEqual([]); // refused places are neither dropped nor shown with an unchecked climate
    expect(out.stoppedBy).toBe("climate_cap");
  });

  it("a hit cap only stops misses: places with a cached climate are still verified after it", async () => {
    const places = manyPlaces(7);
    // the 7th place (lat 40) has its climate cached: it never asks fetchAllowed
    const climate = vi.fn(async (p: { lat: number }, _c: unknown, fetchAllowed: () => boolean) =>
      p.lat === 40 ? ok(climateYear(20, 10, 5)) : fetchAllowed() ? ok(climateYear(5, 0, 18)) : bad("timeout"),
    );
    const d = deps({ geocode: vi.fn(async () => ok([places.shift()!])), climate });
    const out = await verifyIdeas(base({ ideas: nth(7), origins: [], maxHours: null }), d);
    expect(out.drops).toEqual({ climate: 5 });
    expect(out.cards.map((c) => c.geoId)).toEqual([7006]);
    expect(out.stoppedBy).toBe("climate_cap");
  });

  it("time budget: ideas not reached are not shown, the cards done so far are kept", async () => {
    let t = 0;
    const d = deps({ now: () => t, climate: vi.fn(async () => { t += VERIFY_BUDGET_MS; return ok(climateYear(20, 10, 5)); }) });
    const out = await verifyIdeas(base({ ideas: eight.slice(0, 4), origins: [], maxHours: null }), d);
    expect(out.stoppedBy).toBe("time");
    expect(out.cards.length).toBeGreaterThanOrEqual(1);
    expect(out.cards.length).toBeLessThan(4);
  });

  it("cards come back in idea order, whatever finishes first", async () => {
    const climate = vi.fn(async (p: { lat: number }) => {
      if (p.lat > 38) await new Promise((r) => setTimeout(r, 15)); // Palma (39.57) answers late
      return ok(climateYear(20, 10, 5));
    });
    const out = await verifyIdeas(base({ ideas: [idea("Palma"), idea("Marbella"), idea("Faro")], origins: [], maxHours: null }), deps({ climate }));
    expect(out.cards.map((c) => c.placeName)).toEqual(["Palma", "Marbella", "Faro"]);
  });
});

describe("anchor resolution (step 1)", () => {
  const lisbon: GeoPlace = { ...PLACES.Lisboa, name: "Lisbon" };
  const lisbonDe: GeoPlace = { ...PLACES.Lisboa, name: "Lissabon", admin1: "Lissabon" };

  it("English GeoNames spelling resolves with one call; the localized name comes from the cached place-by-id read", async () => {
    const geocode = vi.fn(async () => ok([lisbon]));
    const placeById = vi.fn(async () => lisbonDe);
    const out = await verifyIdeas(base({ ideas: [idea("Lisbon", { name: "Lissabon", cc: "PT" })], interests: [], months: [], origins: [], maxHours: null }), deps({ geocode, placeById }));
    expect(geocode).toHaveBeenCalledTimes(1);
    expect(geocode).toHaveBeenCalledWith("Lisbon", "en", "u1");
    expect(placeById).toHaveBeenCalledWith(2267057, "de");
    expect(out.cards[0]).toMatchObject({ name: "Lissabon", placeName: "Lissabon", kind: "city", geoId: 2267057 });
  });

  it("an English request needs no by-id read", async () => {
    const placeById = vi.fn(async () => null);
    await verifyIdeas(base({ lang: "en", ideas: [idea("Lisbon", { cc: "PT" })], interests: [], months: [] }), deps({ geocode: vi.fn(async () => ok([lisbon])), placeById }));
    expect(placeById).not.toHaveBeenCalled();
  });

  it("a miss in English is retried once in German (local spellings), then 3 calls at most per idea", async () => {
    const cologne: GeoPlace = { ...PLACES.Passau, geoId: 2886242, name: "Köln", countryCode: "DE" };
    const geocode = vi.fn(async (_a: string, lang: string) => ok(lang === "de" ? [cologne] : []));
    const placeById = vi.fn(async () => null);
    const out = await verifyIdeas(base({ ideas: [idea("Köln", { cc: "DE" })], interests: [], months: [], origins: [], maxHours: null }), deps({ geocode, placeById }));
    expect(geocode.mock.calls.map((c) => c[1])).toEqual(["en", "de"]);
    expect(out.cards[0].placeName).toBe("Köln");
    expect(geocode.mock.calls.length + placeById.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("not found in both languages is a real negative: not_found, 2 calls", async () => {
    const geocode = vi.fn(async () => ok([]));
    const out = await verifyIdeas(base({ ideas: [idea("Atlantis", { cc: "PT" })] }), deps({ geocode }));
    expect(geocode).toHaveBeenCalledTimes(2);
    expect(out.drops).toEqual({ not_found: 1 });
  });

  it("a failure of the retry is a failure, not 'not found'", async () => {
    const geocode = vi.fn(async (_a: string, lang: string) => (lang === "en" ? ok([]) : bad("timeout")));
    const out = await verifyIdeas(base({ ideas: [idea("Marbella"), idea("Faro")] }), deps({ geocode }));
    expect(out.geocodeDown).toBe(true);
  });

  it("a failed by-id read falls back to the English name", async () => {
    const out = await verifyIdeas(
      base({ ideas: [idea("Lisbon", { name: "Lissabon", cc: "PT" })], interests: [], months: [] }),
      deps({ geocode: vi.fn(async () => ok([lisbon])), placeById: vi.fn(async () => null) }),
    );
    expect(out.cards[0]).toMatchObject({ placeName: "Lisbon", name: "Lissabon", kind: "region" });
  });

  it("the card name is filtered like the reason: a banned name becomes the verified place", async () => {
    const out = await verifyIdeas(base({ ideas: [idea("Marbella", { name: "Marbella ab 49 € Direktflug" })], interests: [], months: [] }), deps());
    expect(out.cards[0]).toMatchObject({ name: "Marbella", kind: "city" });
  });
});

describe("verifyIdeas: drive mode (find-destinations-drive T1 to T9)", () => {
  const geo = (geoId: number, name: string, lat: number, lon: number, countryCode = "DE"): GeoPlace => ({ geoId, name, featureCode: "PPL", countryCode, admin1: null, lat, lon, timezone: "Europe/Berlin", population: 100000, suggestedKind: "city" });
  const WORLD: Record<string, GeoPlace> = {
    Munich: geo(2867714, "Munich", 48.14, 11.58),
    Marseille: geo(2995469, "Marseille", 43.3, 5.37, "FR"),
    Palma: PLACES.Palma,
    Sassnitz: geo(2842647, "Sassnitz", 54.51, 13.64),
    Freiburg: geo(2925177, "Freiburg", 47.99, 7.85),
    Wuerzburg: geo(2805615, "Würzburg", 49.79, 9.94),
    Kassel: geo(2892518, "Kassel", 51.32, 9.5),
    Nuremberg: geo(2861650, "Nuremberg", 49.45, 11.08),
    Stuttgart: geo(2825297, "Stuttgart", 48.78, 9.18),
    Cologne: geo(2886242, "Cologne", 50.94, 6.96),
    Bonn: geo(2946447, "Bonn", 50.73, 7.1),
    Hamburg: geo(2911298, "Hamburg", 53.55, 9.99),
    Berlin: geo(2950159, "Berlin", 52.52, 13.4),
    Dresden: geo(2935022, "Dresden", 51.05, 13.74),
    Leipzig: geo(2879139, "Leipzig", 51.34, 12.37),
  };
  const FRANKFURT = { lat: 50.11, lon: 8.68 };
  const route = (min: number, km = min): CachedResult<{ road: true; min: number; km: number }> => ok({ road: true as const, min, km });
  const noRoad = ok({ road: false as const });
  const driveDeps = (over: Partial<VerifyDeps> = {}) =>
    deps({
      geocode: vi.fn(async (a: string) => ok(WORLD[a] ? [WORLD[a]] : [])),
      driveRoute: vi.fn(async () => route(200)),
      ...over,
    });
  const driveBase = (over: Partial<VerifyInput> = {}) => base({ origins: [], maxHours: null, months: [], drive: { home: FRANKFURT, maxHours: 4 }, ...over });
  const ideaIn = (anchor: string) => idea(anchor, { cc: WORLD[anchor]?.countryCode ?? "DE" });

  it("T1: Frankfurt, 4 h: Munich gets a card with a verified drive, Marseille is cut by the straight line with no ORS call", async () => {
    const d = driveDeps({ driveRoute: vi.fn(async () => route(210, 392.3)) });
    const out = await verifyIdeas(driveBase({ ideas: [ideaIn("Munich"), ideaIn("Marseille")] }), d);
    expect(out.cards.map((c) => c.placeName)).toEqual(["Munich"]);
    expect(out.cards[0].drive).toEqual({ min: 210, km: 392.3, source: "openrouteservice", fetchedAt: "2026-11-01T10:00:00.000Z", stale: false });
    expect(out.cards[0]).toMatchObject({ flight: null, nearAirport: false });
    expect(out.drops).toEqual({ too_far: 1 });
    expect(d.driveRoute).toHaveBeenCalledTimes(1);
    expect(d.driveRoute).toHaveBeenCalledWith(FRANKFURT, expect.objectContaining({ geoId: 2867714 }), expect.anything());
    expect(out.driveLookups).toBe(1);
  });

  it("the limit is checked by ORS time + 10 min: 250 min passes a 4 h limit, 251 does not", async () => {
    const pass = await verifyIdeas(driveBase({ ideas: [ideaIn("Munich")] }), driveDeps({ driveRoute: vi.fn(async () => route(250)) }));
    expect(pass.cards).toHaveLength(1);
    const fail = await verifyIdeas(driveBase({ ideas: [ideaIn("Munich")] }), driveDeps({ driveRoute: vi.fn(async () => route(251)) }));
    expect(fail.cards).toEqual([]);
    expect(fail.drops).toEqual({ too_far: 1 });
  });

  it("T2: a Mallorca idea has no road: no_road (not too_far), and no climate miss is used", async () => {
    const d = driveDeps({ driveRoute: vi.fn(async () => noRoad) });
    const out = await verifyIdeas(driveBase({ ideas: [ideaIn("Palma")], months: [3], drive: { home: FRANKFURT, maxHours: 12 } }), d);
    expect(out.drops).toEqual({ no_road: 1 });
    expect(out.cards).toEqual([]);
    expect(d.climate).not.toHaveBeenCalled();
    expect(out.climateMisses).toBe(0);
    expect(out.driveDown).toBe(false);
  });

  it("T3: a bridged island (Rügen) keeps its card", async () => {
    const out = await verifyIdeas(driveBase({ ideas: [ideaIn("Sassnitz")], drive: { home: { lat: 54.3, lon: 13.1 }, maxHours: 2 } }), driveDeps({ driveRoute: vi.fn(async () => route(57, 51.8)) }));
    expect(out.cards.map((c) => c.placeName)).toEqual(["Sassnitz"]);
  });

  it("T4: 12 h limit, an 11 h 50 route passes although it is over MAX_DRIVE_MIN (180)", async () => {
    const out = await verifyIdeas(driveBase({ ideas: [ideaIn("Munich")], drive: { home: FRANKFURT, maxHours: 12 } }), driveDeps({ driveRoute: vi.fn(async () => route(710, 1000)) }));
    expect(out.cards[0].drive).toMatchObject({ min: 710 });
  });

  it("T5: ORS fails for every lookup: it stops after 2, driveDown, nothing is shown", async () => {
    const d = driveDeps({ driveRoute: vi.fn(async () => bad("timeout")) });
    const out = await verifyIdeas(driveBase({ ideas: [ideaIn("Munich"), ideaIn("Freiburg"), ideaIn("Kassel"), ideaIn("Wuerzburg"), ideaIn("Cologne")] }), d);
    expect(out.driveDown).toBe(true);
    expect(out.cards).toEqual([]);
    expect(d.driveRoute).toHaveBeenCalledTimes(2);
  });

  it("T6: one lookup fails, the others stay and the failure is counted drive_failed (never no_road)", async () => {
    const driveRoute = vi.fn(async (_o: unknown, p: { geoId: number }) => (p.geoId === WORLD.Freiburg.geoId ? bad("provider_error") : route(150)));
    const out = await verifyIdeas(driveBase({ ideas: [ideaIn("Munich"), ideaIn("Freiburg"), ideaIn("Kassel")] }), driveDeps({ driveRoute }));
    expect(out.driveDown).toBe(false);
    expect(out.cards.map((c) => c.placeName).sort()).toEqual(["Kassel", "Munich"]);
    expect(out.drops).toEqual({ drive_failed: 1 });
  });

  it("T7: a cached route is a stale fact, not a failure: the card carries stale: true", async () => {
    const out = await verifyIdeas(driveBase({ ideas: [ideaIn("Munich")] }), driveDeps({ driveRoute: vi.fn(async () => ({ ...route(200), stale: true, cache: "stale" as const })) }));
    expect(out.cards[0].drive).toMatchObject({ stale: true });
  });

  it("T8: once 5 cards are found no further ORS call is made", async () => {
    const ideas = ["Munich", "Freiburg", "Kassel", "Wuerzburg", "Nuremberg", "Stuttgart", "Cologne", "Bonn"].map(ideaIn);
    const d = driveDeps();
    const out = await verifyIdeas(driveBase({ ideas, drive: { home: FRANKFURT, maxHours: 8 } }), d);
    expect(out.cards.length).toBeLessThanOrEqual(5);
    // concurrency 2 may start one extra lookup, never the whole tail
    expect((d.driveRoute as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("drive is the first step: a place that is out of range uses no climate lookup, one in range checks climate afterwards", async () => {
    const order: string[] = [];
    const d = driveDeps({
      driveRoute: vi.fn(async () => (order.push("drive"), route(120))),
      climate: vi.fn(async () => (order.push("climate"), ok(climateYear(20, 10, 5)))),
    });
    await verifyIdeas(driveBase({ ideas: [ideaIn("Kassel")], months: [6], interests: [] }), d);
    expect(order).toEqual(["drive", "climate"]);
  });

  it("the Estimate inputs are empty in drive mode: no flight line, whatever airports the caller passed", async () => {
    const out = await verifyIdeas(driveBase({ ideas: [ideaIn("Munich")], origins: ["FRA"] }), driveDeps());
    expect(out.cards[0]).toMatchObject({ flight: null, nearAirport: false });
  });

  it("a flight search never touches ORS", async () => {
    const d = deps();
    await verifyIdeas(base(), d);
    expect(d.driveRoute).not.toHaveBeenCalled();
  });

  it("stops after 3 failed lookups in a row even after a success; the places not reached count as drive_failed and stay unchecked", async () => {
    const names = ["Munich", "Freiburg", "Kassel", "Nuremberg", "Stuttgart", "Cologne"];
    let n = 0;
    const driveRoute = vi.fn(async () => (++n === 1 ? route(150) : bad("timeout")));
    const d = driveDeps({ driveRoute });
    const out = await verifyIdeas(driveBase({ ideas: names.map(ideaIn), drive: { home: FRANKFURT, maxHours: 8 } }), d);
    expect(out.driveDown).toBe(false);
    expect(out.cards.map((c) => c.placeName)).toEqual(["Munich"]);
    // 1 success + 3 failures in a row, then no more lookups (concurrency may have one extra in flight)
    expect(driveRoute.mock.calls.length).toBeLessThanOrEqual(5);
    expect(out.drops).toEqual({ drive_failed: 5 });
    expect(out.uncheckedAnchors).toHaveLength(5);
    expect(out.uncheckedAnchors).not.toContain("Munich");
  });

  it("places no lookup reached because 5 cards were found stay unchecked (eligible for 'Show others') without a drop count", async () => {
    const names = ["Munich", "Freiburg", "Kassel", "Nuremberg", "Stuttgart", "Cologne", "Hamburg", "Berlin", "Dresden", "Leipzig"];
    const out = await verifyIdeas(driveBase({ ideas: names.map(ideaIn), drive: { home: FRANKFURT, maxHours: 12 } }), driveDeps());
    expect(out.cards.length).toBeGreaterThanOrEqual(5);
    expect(out.drops.drive_failed).toBeUndefined();
    expect(out.uncheckedAnchors.length).toBeGreaterThan(0);
    expect(out.uncheckedAnchors).not.toContain("Munich");
  });

  it("an idea whose geocoding failed is unchecked too (eligible for 'Show others'); a real not_found stays excluded", async () => {
    const geocode = vi.fn(async (a: string) => (a === "Freiburg" ? bad("timeout") : ok(WORLD[a] ? [WORLD[a]] : [])));
    const out = await verifyIdeas(driveBase({ ideas: [ideaIn("Munich"), ideaIn("Freiburg"), idea("Nowhereville", { cc: "DE" })] }), driveDeps({ geocode }));
    expect(out.drops).toEqual({ geocode_failed: 1, not_found: 1 });
    expect(out.uncheckedAnchors).toEqual(["Freiburg"]);
  });

  it("a success in between resets the run of failures", async () => {
    const names = ["Munich", "Freiburg", "Kassel", "Nuremberg", "Stuttgart", "Cologne"];
    const seq = [true, false, false, true, false, false];
    let n = 0;
    const driveRoute = vi.fn(async () => (seq[n++] ? route(150) : bad()));
    const out = await verifyIdeas(driveBase({ ideas: names.map(ideaIn), drive: { home: FRANKFURT, maxHours: 8 } }), driveDeps({ driveRoute }));
    expect(driveRoute).toHaveBeenCalledTimes(6);
    expect(out.drops).toEqual({ drive_failed: 4 });
  });

  it("T9: the drive path imports no AeroDataBox module", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["verify.ts", "../facts/drive-route.ts", "../facts/ors-quota.ts", "../../discover/drive.ts"]) {
      expect(readFileSync(new URL(f, import.meta.url), "utf8")).not.toMatch(/from\s+["'][^"']*aerodatabox/i);
    }
  });
});
