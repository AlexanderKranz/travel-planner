import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
type Opts = { key: string; provider: string; endpoint: string; ttlSeconds: number };
const mockState = vi.hoisted(() => ({ impl: ((o: unknown): unknown => o) as (o: unknown) => unknown, calls: [] as unknown[] }));
const cachedMock = {
  get mock() { return { calls: mockState.calls.map((c) => [c as Opts]) }; },
  mockReset() { mockState.calls = []; mockState.impl = () => undefined; },
  mockResolvedValue(v: unknown) { mockState.impl = () => Promise.resolve(v); },
  mockImplementation(f: (o: Opts) => unknown) { mockState.impl = f as (o: unknown) => unknown; },
};

vi.mock("../api-cache", () => ({
  cached: (opts: unknown) => { mockState.calls.push(opts); return mockState.impl(opts); },
  cacheKey: (e: string, v: number, p: Record<string, string | number>) =>
    `${e}:v${v}:${Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join(";")}`,
}));

import type { FactsCtx } from "@/lib/domain/facts";
import type { Trip } from "@/lib/domain/trip";
import type { TripPurpose } from "@/lib/domain/purpose";
import { getCountryFacts } from "./country";
import { getDaylightFacts } from "./daylight";
import { getTripFacts, warmTripFacts } from "./index";
import { getPlacesFacts } from "./places";
import { getSummaryFacts } from "./summary";
import { getWeatherFacts } from "./weather";

const ctx: FactsCtx = { userId: "u1", locale: "de", today: "2026-10-28" };
const base = { id: "t1", lengthDays: 7, groupId: null, purposeId: null, wantsFlights: false, originAirports: [], createdAt: "", updatedAt: "" };
const passau: Trip = {
  ...base,
  timing: { kind: "months", months: [12] },
  destination: { kind: "city", name: "Passau", placeName: "Passau", geoId: 2855328, countryCode: "DE", admin1: "Bayern", lat: 48.5665, lon: 13.43122, timezone: "Europe/Berlin", radiusKm: 15 },
};
const free: Trip = { ...base, timing: { kind: "none" }, destination: { kind: "freetext", name: "Irgendwo", countryCode: undefined as never } };
const purpose = (interests: string[]): TripPurpose => ({ id: "p", name: "p", guided: { interests }, constraints: [], createdAt: "", updatedAt: "" });

const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, tMaxC: 10, tMinC: 2, precipMm: 50, wetDays: 8, sunshineHours: 4 }));
const hit = (data: unknown, extra = {}) => ({ ok: true, data, fetchedAt: "2026-10-01T00:00:00.000Z", stale: false, cache: "hit", ...extra });

beforeEach(() => cachedMock.mockReset());

describe("server facts", () => {
  it("weather: wraps the cached aggregate with selected months and provenance", async () => {
    cachedMock.mockResolvedValue(hit(months));
    const f = await getWeatherFacts(passau, ctx);
    expect(f).toMatchObject({ status: "ok", source: "open_meteo", stale: false, fetchedAt: "2026-10-01T00:00:00.000Z" });
    if (f.status === "ok") {
      expect(f.data.selectedMonths).toEqual([12]);
      expect(f.data.period).toEqual({ from: 2016, to: 2025 });
    }
    const opts = cachedMock.mock.calls[0][0];
    expect(opts).toMatchObject({ provider: "open_meteo_archive", endpoint: "archive", ttlSeconds: 365 * 86400 });
    expect(opts.key).toBe("climate:v1:from=2016;lat=48.57;lon=13.43;to=2025");
  });

  it("weather: stale flag and provider errors are passed on; freetext has no location", async () => {
    cachedMock.mockResolvedValue(hit(months, { stale: true, cache: "stale" }));
    expect((await getWeatherFacts(passau, ctx)).status === "ok" && (await getWeatherFacts(passau, ctx))).toMatchObject({ stale: true });
    cachedMock.mockResolvedValue({ ok: false, error: "timeout" });
    expect(await getWeatherFacts(passau, ctx)).toEqual({ status: "unavailable", reason: "provider_error", source: "open_meteo" });
    expect(await getWeatherFacts(free, ctx)).toEqual({ status: "unavailable", reason: "no_location" });
  });

  it("weather: a throwing cache never throws", async () => {
    cachedMock.mockImplementation(() => { throw new Error("boom"); });
    expect((await getWeatherFacts(passau, ctx)).status).toBe("unavailable");
  });

  it("daylight: computed for the 15th of December, no API", async () => {
    const f = await getDaylightFacts(passau, ctx);
    expect(f.status).toBe("ok");
    if (f.status === "ok") {
      expect(f.source).toBe("suncalc");
      expect(f.data).toMatchObject({ timezone: "Europe/Berlin", basis: "mid_month" });
      expect(f.data.days.map((d) => d.date)).toEqual(["2026-12-15"]);
    }
    expect(cachedMock.mock.calls).toHaveLength(0);
    expect(await getDaylightFacts(free, ctx)).toEqual({ status: "unavailable", reason: "no_location" });
  });

  it("country: Germany with winter offset; freetext without country -> no_country; unknown code -> not_found", async () => {
    const f = await getCountryFacts(passau, ctx);
    expect(f.status).toBe("ok");
    if (f.status === "ok") {
      expect(f.data).toMatchObject({ code: "DE", nameEn: "Germany", plugs: null });
      expect(f.data.timezone).toEqual({ iana: "Europe/Berlin", utcOffsets: ["+01:00"], countryZones: [] });
      expect(f.source).toBe("rest_countries");
    }
    expect(await getCountryFacts(free, ctx)).toEqual({ status: "unavailable", reason: "no_country" });
    const odd = { ...free, destination: { kind: "freetext" as const, name: "x", countryCode: "ZZ" } };
    expect(await getCountryFacts(odd, ctx)).toMatchObject({ status: "unavailable", reason: "not_found" });
  });

  it("summary: ok, not found (cached null), error", async () => {
    const s = { title: "Passau", extract: "Text", url: "https://de.wikivoyage.org/wiki/Passau", lang: "de" };
    cachedMock.mockResolvedValue(hit(s));
    expect(await getSummaryFacts(passau, ctx)).toMatchObject({ status: "ok", source: "wikivoyage", sourceUrl: s.url });
    expect(cachedMock.mock.calls[0][0].key).toBe("summary:v2:geo=2855328;lang=de");
    cachedMock.mockResolvedValue(hit(null));
    expect(await getSummaryFacts(passau, ctx)).toMatchObject({ status: "unavailable", reason: "not_found" });
    cachedMock.mockResolvedValue({ ok: false, error: "provider_error" });
    expect(await getSummaryFacts(passau, ctx)).toMatchObject({ status: "unavailable", reason: "provider_error" });
  });

  it("summary: a short Wikivoyage intro falls back to a longer Wikipedia intro; a long one is kept", async () => {
    const voyage = { title: "Passau", extract: "Kurz.", url: "https://de.wikivoyage.org/wiki/Passau", lang: "de" };
    const pedia = { title: "Passau", extract: "x".repeat(450), url: "https://de.wikipedia.org/wiki/Passau", lang: "de" };
    cachedMock.mockImplementation(async (o) => (o.provider === "wikipedia" ? hit(pedia) : hit(voyage)));
    expect(await getSummaryFacts(passau, ctx)).toMatchObject({ status: "ok", source: "wikipedia", sourceUrl: pedia.url });
    expect(cachedMock.mock.calls.map((c) => c[0].provider)).toEqual(["wikivoyage", "wikipedia"]);

    cachedMock.mockReset();
    const longVoyage = { ...voyage, extract: "y".repeat(500) };
    cachedMock.mockImplementation(async (o) => (o.provider === "wikipedia" ? hit(pedia) : hit(longVoyage)));
    expect(await getSummaryFacts(passau, ctx)).toMatchObject({ status: "ok", source: "wikivoyage" });
    expect(cachedMock.mock.calls).toHaveLength(1);

    cachedMock.mockReset();
    cachedMock.mockImplementation(async (o) => (o.provider === "wikipedia" ? { ok: false, error: "provider_error" } : hit(voyage)));
    expect(await getSummaryFacts(passau, ctx)).toMatchObject({ status: "ok", source: "wikivoyage" });
  });

  it("places: one sequential query per OSM interest, no_source reported, empty cached result", async () => {
    const cand = { osmType: "way", osmId: 1, name: "Dom", names: {}, category: "building=cathedral", lat: 1, lon: 1, distanceKm: 1, osmUrl: "u" };
    cachedMock.mockImplementation(async (o) => (o.key.includes("interest=golf") ? hit([cand]) : hit([])));
    const f = await getPlacesFacts(passau, purpose(["golf", "cruise", "beach", "custom thing"]), ctx);
    expect(f.status).toBe("ok");
    if (f.status === "ok") {
      expect(f.data.groups.map((g) => [g.interest, g.status])).toEqual([["golf", "ok"], ["cruise", "no_source"], ["beach", "empty"]]);
      expect(f.data.customInterests).toEqual(["custom thing"]);
      expect(f.data.radiusKm).toBe(40);
      expect(f.source).toBe("osm");
    }
    expect(cachedMock.mock.calls).toHaveLength(2);
    expect(cachedMock.mock.calls[0][0].key).toBe("interpreter:v2:interest=golf;lat=48.566;lon=13.431;r=40");
    expect(cachedMock.mock.calls[0][0].ttlSeconds).toBe(30 * 86400);
  });

  it("places: no purpose -> general; all errors -> unavailable; over budget -> remaining groups error", async () => {
    cachedMock.mockResolvedValue({ ok: false, error: "timeout" });
    expect(await getPlacesFacts(passau, null, ctx)).toMatchObject({ status: "unavailable", reason: "provider_error" });
    expect(cachedMock.mock.calls[0][0].key).toContain("interest=general");

    cachedMock.mockReset();
    cachedMock.mockResolvedValue(hit([]));
    const f = await getPlacesFacts(passau, purpose(["golf", "beach"]), ctx, { budgetMs: -1 });
    if (f.status !== "ok") throw new Error("expected ok");
    expect(f.data.groups.map((g) => g.status)).toEqual(["empty", "error"]);
    expect(cachedMock.mock.calls).toHaveLength(1);
  });

  it("getTripFacts bundles everything, never throws; warmTripFacts resolves", async () => {
    cachedMock.mockImplementation(() => { throw new Error("down"); });
    const tf = await getTripFacts(passau, null, ctx);
    expect(tf.tripId).toBe("t1");
    expect(tf.referenceDates).toEqual(["2026-12-15"]);
    expect(tf.daylight.status).toBe("ok");
    expect(tf.country.status).toBe("ok");
    expect(tf.weather.status).toBe("unavailable");
    await expect(warmTripFacts(passau, null, ctx)).resolves.toBeUndefined();
  });
});
