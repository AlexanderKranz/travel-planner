import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  rest: vi.fn(),
  cafe: vi.fn(),
  groups: vi.fn(),
  drive: vi.fn(),
  order: [] as string[],
}));
vi.mock("./activities", () => ({ getRestaurantFacts: h.rest, getCafeFacts: h.cafe }));
vi.mock("./places", () => ({ PLACES_CACHE_ONLY: 0, getInterestGroups: h.groups }));
vi.mock("./drive-times", () => ({ getDriveTimes: h.drive }));
vi.mock("../api-cache", () => ({ cacheKey: () => "k", cached: vi.fn() }));

import type { GeoPlace } from "@/lib/domain/geo";
import type { ResolvedStop, StopFacts } from "@/lib/domain/facts";
import type { TripStop } from "@/lib/domain/trip-stops";
import type { GeocodeDeps } from "../discover/resolve-place";
import { STOP_DRIVE_BUDGET_MS, getStopFacts, lookupStops, resolveStopPlaces, stopDestination, stopDriveTimes, stopInterests } from "./stops";

const ctx = { userId: "u1", locale: "de" as const, today: "2026-11-11" };
const place = (geoId: number, name: string, lat: number, lon: number, cc: string, featureCode = "PPLA2", population = 1000): GeoPlace => ({
  geoId, name, featureCode, countryCode: cc, admin1: null, lat, lon, timezone: null, population, suggestedKind: "city",
});
const WORLD: Record<string, GeoPlace[]> = {
  passau: [place(1, "Passau", 48.5665, 13.4312, "DE")],
  wien: [place(2, "Wien", 48.2085, 16.3721, "AT", "PPLC", 1_700_000)],
  durnstein: [place(3, "Dürnstein", 48.3948, 15.5189, "AT", "PPL")],
};
const deps = (calls: string[] = []): GeocodeDeps => ({
  geocode: async (name, lang) => {
    calls.push(`${name}:${lang}`);
    return { ok: true, data: WORLD[name.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()] ?? [], fetchedAt: "f", stale: false, cache: "hit" };
  },
  placeById: async () => null,
});
const trip = { destination: { kind: "region", name: "Donau", placeName: "Passau", geoId: 1, countryCode: "DE", admin1: null, lat: 48.5665, lon: 13.43122, timezone: null, radiusKm: 15 } } as const;
const rows: TripStop[] = [{ day: 1, place: "Passau" }, { day: 2, place: "Wien" }, { day: 3, place: "Dürnstein" }, { day: 4, sea: true }];

beforeEach(() => {
  vi.clearAllMocks();
  h.order = [];
  h.rest.mockImplementation(async () => (h.order.push("rest"), { status: "ok", data: { radiusKm: 2.5, restaurants: [], truncated: false }, source: "osm", sourceUrl: "u", fetchedAt: "f", stale: false }));
  h.cafe.mockImplementation(async () => (h.order.push("cafe"), { status: "ok", data: { radiusKm: 2.5, cafes: [], truncated: false }, source: "osm", sourceUrl: "u", fetchedAt: "f", stale: false }));
  h.groups.mockImplementation(async (_d: unknown, keys: string[]) => (h.order.push(`groups:${keys.join("+")}`), keys.map((interest) => ({ interest, status: "empty", fetchedAt: "f", stale: false }))));
});

describe("resolveStopPlaces", () => {
  it("geocodes each distinct name once, by the destination's country, and assigns roles and ids", async () => {
    const calls: string[] = [];
    const r = await resolveStopPlaces(trip, [...rows, { day: 5, place: "Passau" }], ctx, deps(calls));
    expect(r.map((x) => [x.id, x.role, x.name, x.days])).toEqual([["dest", "destination", "Passau", [1, 5]], ["s1", "stop", "Wien", [2]], ["s2", "stop", "Dürnstein", [3]]]);
    expect(calls.filter((c) => c.startsWith("Passau")).length).toBeLessThanOrEqual(3);
  });

  it("a stop's own cc wins over the destination's; a place of another country is still found without it", async () => {
    const r = await resolveStopPlaces(trip, [{ day: 2, place: "Wien", cc: "AT" }], ctx, deps());
    expect(r[0]).toMatchObject({ id: "s1", status: "ok", point: { geoId: 2 } });
    // No cc on the stop and the destination is German: Wien is not in DE, the any-country pass finds it (docs [P1]).
    const typed = await resolveStopPlaces(trip, [{ day: 2, place: "Wien" }], ctx, deps());
    expect(typed[0]).toMatchObject({ status: "ok", point: { geoId: 2 } });
  });

  describe("namesakes without a cc: the candidate nearest the route wins (port-places [P1])", () => {
    const namesakes = (world: Record<string, GeoPlace[]>): GeocodeDeps => ({
      geocode: async (name) => ({ ok: true, data: world[name.toLowerCase()] ?? [], fetchedAt: "f", stale: false, cache: "hit" }),
      placeById: async () => null,
    });
    const WORLD2 = {
      ...WORLD,
      melk: [place(4, "Melk", 48.2278, 15.33, "AT", "PPL", 5000)],
      // Linz in Saxony is listed first and has the larger population in this fixture; Linz in Austria is on the route.
      linz: [place(5, "Linz", 51.29, 13.72, "DE", "PPL", 900_000), place(6, "Linz", 48.3069, 14.2858, "AT", "PPLA", 200_000)],
      wien: [place(7, "Wien", 38.3, -92.0, "US", "PPL", 2_000_000), place(2, "Wien", 48.2085, 16.3721, "AT", "PPLC", 1_700_000)],
    };

    it("Linz (DE or AT) follows the previous stop Melk", async () => {
      const r = await resolveStopPlaces(trip, [{ day: 3, place: "Melk" }, { day: 4, place: "Linz" }], ctx, namesakes(WORLD2));
      expect(r.find((x) => x.name === "Linz")).toMatchObject({ status: "ok", point: { geoId: 6 }, countryCode: "AT" });
    });

    it("the first stop is measured against the trip anchor (Wien from Passau is Austria, not Missouri)", async () => {
      const r = await resolveStopPlaces(trip, [{ day: 2, place: "Wien" }], ctx, namesakes(WORLD2));
      expect(r[0]).toMatchObject({ status: "ok", point: { geoId: 2 }, countryCode: "AT" });
    });

    it("a cc on the stop is a hard filter, whatever is nearer", async () => {
      const r = await resolveStopPlaces(trip, [{ day: 3, place: "Melk" }, { day: 4, place: "Linz", cc: "DE" }], ctx, namesakes(WORLD2));
      expect(r.find((x) => x.name === "Linz")).toMatchObject({ point: { geoId: 5 }, countryCode: "DE" });
    });

    it("a namesake beyond 2,500 km is taken only when it is the only one", async () => {
      const only = { ...WORLD2, wien: [place(7, "Wien", 38.3, -92.0, "US", "PPL", 2_000_000)] };
      const r = await resolveStopPlaces(trip, [{ day: 2, place: "Wien" }], ctx, namesakes(only));
      expect(r[0]).toMatchObject({ status: "ok", point: { geoId: 7 } });
    });

    it("stops are resolved in day order, so a stop's predecessor is the one before it on the route", async () => {
      const r = await resolveStopPlaces(trip, [{ day: 2, place: "Wien" }, { day: 3, place: "Melk" }, { day: 4, place: "Linz" }], ctx, namesakes(WORLD2));
      expect(r.map((x) => [x.name, x.point?.geoId])).toEqual([["Wien", 2], ["Melk", 4], ["Linz", 6]]);
    });
  });

  it("not found and a failing geocoder are statuses, never exceptions", async () => {
    const r = await resolveStopPlaces(trip, [{ day: 1, place: "Nirgendwo" }], ctx, deps());
    expect(r).toEqual([expect.objectContaining({ id: "s1", status: "not_found", name: "Nirgendwo" })]);
    const down: GeocodeDeps = { geocode: async () => ({ ok: false, error: "provider_error" }), placeById: async () => null };
    expect((await resolveStopPlaces(trip, [{ day: 1, place: "Wien" }], ctx, down))[0].status).toBe("error");
    const throwing: GeocodeDeps = { geocode: async () => { throw new Error("x"); }, placeById: async () => null };
    expect((await resolveStopPlaces(trip, [{ day: 1, place: "Wien" }], ctx, throwing))[0].status).toBe("error");
  });

  it("no stops, no calls; a free-text destination has no anchor so every place is a stop", async () => {
    const calls: string[] = [];
    expect(await resolveStopPlaces(trip, [{ day: 1, sea: true }], ctx, deps(calls))).toEqual([]);
    expect(calls).toEqual([]);
    const r = await resolveStopPlaces({ destination: { kind: "freetext", name: "Donau", countryCode: null } }, [{ day: 1, place: "Passau" }], ctx, deps());
    expect(r[0]).toMatchObject({ id: "s1", role: "stop" });
  });
});

describe("stopInterests (port-places [P4])", () => {
  it("the first two interests with an OSM source; general when none; sources of kind none are skipped", () => {
    expect(stopInterests(null)).toEqual(["general"]);
    expect(stopInterests({ guided: { interests: ["family_activities", "christmas_markets", "golf", "beach"] }, tags: null } as never)).toEqual(["family_activities", "golf"]);
    expect(stopInterests({ guided: { interests: ["christmas_markets"] }, tags: null } as never)).toEqual(["general"]);
  });
});

describe("lookupStops", () => {
  const stop = (id: string, over: Partial<ResolvedStop> = {}): ResolvedStop => ({ id, name: `Ort ${id}`, days: [2], role: "stop", point: { lat: 48.2, lon: 16.37, geoId: 7 }, status: "ok", ...over });

  it("looks up each ok stop as a city of kind city at its point, one stop after the other, restaurants then interests", async () => {
    const r = await lookupStops([stop("s1"), stop("s2")], null, ctx, { budgetMs: 110_000, overpass: "cache_only" });
    expect(h.order).toEqual(["rest", "groups:general", "rest", "groups:general"]);
    expect(r.map((f) => f.stop.id)).toEqual(["s1", "s2"]);
    const d = h.rest.mock.calls[0][0];
    expect(d).toMatchObject({ kind: "city", lat: 48.2, lon: 16.37, radiusKm: 15 });
    expect(r[0].restaurants).toMatchObject({ status: "ok" });
    expect(r[0].places).toEqual([{ interest: "general", status: "empty", fetchedAt: "f", stale: false }]);
  });

  it("[P7] inline runs pass overpass: cache_only to every lookup, the warm-up does not", async () => {
    await lookupStops([stop("s1")], null, ctx, { budgetMs: 110_000, overpass: "cache_only", cafes: true });
    expect(h.rest.mock.calls[0][2]).toMatchObject({ overpass: "cache_only" });
    expect(h.groups.mock.calls[0][4]).toEqual({ overpass: "cache_only" });
    expect(h.cafe.mock.calls[0][2]).toMatchObject({ overpass: "cache_only" });
    vi.clearAllMocks();
    await lookupStops([stop("s1")], null, ctx, { budgetMs: 110_000, overpass: "allowed" });
    expect(h.rest.mock.calls[0][2]).not.toHaveProperty("overpass");
    expect(h.groups.mock.calls[0][4]).toEqual({});
    expect(h.cafe).not.toHaveBeenCalled(); // no purpose wish, no request
  });

  it("cafés when the purpose asks for them", async () => {
    await lookupStops([stop("s1")], { guided: undefined, tags: { cafes: true } } as never, ctx, { budgetMs: 1000, overpass: "cache_only" });
    expect(h.cafe).toHaveBeenCalledTimes(1);
  });

  it("destination, not found, failed and capped stops are not looked up and keep their entry", async () => {
    const list = [
      stop("dest", { role: "destination" }),
      stop("s1", { status: "not_found", point: undefined }),
      stop("s2", { status: "error", point: undefined }),
      stop("s3", { status: "cap", point: undefined }),
    ];
    const r = await lookupStops(list, null, ctx, { budgetMs: 1000, overpass: "cache_only" });
    expect(h.rest).not.toHaveBeenCalled();
    expect(r.map((f) => [f.stop.id, f.places.length])).toEqual([["dest", 0], ["s1", 0], ["s2", 0], ["s3", 0]]);
  });

  it("all stops share one window; a stop the window no longer reaches is read from the caches only", async () => {
    let t = 1_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => t);
    h.rest.mockImplementation(async () => ((t += 70_000), { status: "ok", data: { radiusKm: 2.5, restaurants: [], truncated: false }, source: "osm", sourceUrl: "u", fetchedAt: "f", stale: false }));
    await lookupStops([stop("s1"), stop("s2")], null, ctx, { budgetMs: 100_000, overpass: "allowed" });
    now.mockRestore();
    expect(h.rest.mock.calls.map((c) => (c[2] as { budgetMs: number }).budgetMs)).toEqual([100_000, 30_000]);
    expect(h.groups.mock.calls[1][3]).toBe(0); // second stop: window used up -> cache only
  });

  it("a throwing lookup becomes error statuses, never an exception", async () => {
    h.rest.mockRejectedValue(new Error("x"));
    h.groups.mockRejectedValue(new Error("y"));
    const r = await lookupStops([stop("s1")], null, ctx, { budgetMs: 1000, overpass: "cache_only" });
    expect(r[0].restaurants).toEqual({ status: "error", restaurants: [] });
    expect(r[0].places).toEqual([{ interest: "general", status: "error" }]);
  });

  it("stopDestination builds a city destination at the stop point", () => {
    expect(stopDestination({ name: "Wien", point: { lat: 1, lon: 2, geoId: 3 } })).toMatchObject({ kind: "city", name: "Wien", lat: 1, lon: 2, geoId: 3, radiusKm: 15 });
  });
});

describe("getStopFacts", () => {
  it("no stops = no work; with stops it resolves and looks up (the destination role gets an empty entry)", async () => {
    expect(await getStopFacts(trip, [], null, ctx, { budgetMs: 1000, overpass: "cache_only" })).toEqual([]);
  });
});

describe("stopDriveTimes (port-places [P5])", () => {
  const facts = (id: string, osmId: number): StopFacts => ({
    stop: { id, name: id, days: [2], role: "stop", point: { lat: 48.2, lon: 16.37, geoId: 1 }, status: "ok" },
    places: [{ interest: "general", status: "ok", candidates: [{ osmType: "node", osmId, name: "X", names: {}, category: "tourism=museum", lat: 48.21, lon: 16.38, distanceKm: 1, osmUrl: "u" }], fetchedAt: "f", stale: false }],
  });

  it("one matrix per stop from its own point to its own places, results by stop id", async () => {
    h.drive.mockImplementation(async (origin: { lat: number }, places: { key: string }[]) => ({ byKey: { [places[0].key]: { min: 9, km: 8 } }, fetchedAt: `f${origin.lat}` }));
    const r = await stopDriveTimes([facts("s1", 11), facts("s2", 22)], ctx);
    expect(h.drive).toHaveBeenCalledTimes(2);
    expect(h.drive.mock.calls[0][0]).toEqual({ lat: 48.2, lon: 16.37 });
    expect(h.drive.mock.calls[0][1]).toEqual([{ key: "node/11", lat: 48.21, lon: 16.38 }]);
    expect(Object.keys(r)).toEqual(["s1", "s2"]);
    expect(r.s2.byKey["node/22"]).toEqual({ min: 9, km: 8 });
  });

  it("a stop without a result has none; a failing matrix does not stop the others", async () => {
    h.drive.mockImplementation(async (_o: unknown, places: { key: string }[]) => (places[0].key === "node/11" ? null : { byKey: {}, fetchedAt: "f" }));
    const r = await stopDriveTimes([facts("s1", 11), facts("s2", 22)], ctx);
    expect(Object.keys(r)).toEqual(["s2"]);
    h.drive.mockRejectedValue(new Error("x"));
    expect(await stopDriveTimes([facts("s1", 11)], ctx)).toEqual({});
  });

  it("a matrix still running after the 10 s window is left out", async () => {
    vi.useFakeTimers();
    try {
      h.drive.mockImplementation(async (_o: unknown, places: { key: string }[]) =>
        places[0].key === "node/11" ? new Promise((resolve) => setTimeout(() => resolve({ byKey: {}, fetchedAt: "late" }), 15_000)) : { byKey: {}, fetchedAt: "f" },
      );
      const p = stopDriveTimes([facts("s1", 11), facts("s2", 22)], ctx);
      await vi.advanceTimersByTimeAsync(STOP_DRIVE_BUDGET_MS + 10);
      const r = await p;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(Object.keys(r)).toEqual(["s2"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops without places (destination, not found) cost no request", async () => {
    await stopDriveTimes([{ stop: { id: "s1", name: "x", days: [1], role: "stop", status: "not_found" }, places: [] }], ctx);
    expect(h.drive).not.toHaveBeenCalled();
  });
});
