import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
type Opts = { provider: string; key: string; fetchAllowed?: () => boolean; fetcher: () => Promise<unknown> };
const h = vi.hoisted(() => ({
  calls: [] as Opts[],
  impl: ((): unknown => undefined) as (o: Opts) => unknown,
  enqueue: vi.fn(),
  runQuery: vi.fn(),
}));
vi.mock("../api-cache", () => ({
  cached: (o: Opts) => {
    h.calls.push(o);
    return Promise.resolve(h.impl(o));
  },
  cacheKey: (e: string, v: number, p: Record<string, string | number>) => `${e}:v${v}:${JSON.stringify(p)}`,
}));
vi.mock("../facts/geoapify-quota", () => ({ assertGeoapifyQuota: async () => {} }));
vi.mock("../place-retries", () => ({ enqueuePlaceRetries: h.enqueue }));
vi.mock("@/lib/integrations/overpass", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/overpass")>()), runQuery: h.runQuery }));

import { cityDestination, cityPlaces } from "./places";

const dest = cityDestination({ name: "Wien", lat: 48.20849, lon: 16.37208 });
const candidate = {
  osmType: "way", osmId: 212496461, name: "Stephansdom", names: { en: "St. Stephen's Cathedral" }, category: "amenity=place_of_worship",
  lat: 48.2085, lon: 16.3731, distanceKm: 0.1, osmUrl: "https://www.openstreetmap.org/way/212496461",
};
const ok = (data: unknown[], cache = "hit") => ({ ok: true, data, fetchedAt: "2026-11-01T00:00:00.000Z", stale: false, cache });

beforeEach(() => {
  h.calls = [];
  h.enqueue.mockReset();
  h.runQuery.mockReset();
  vi.stubEnv("GEOAPIFY_API_KEY", "k");
});
afterEach(() => vi.unstubAllEnvs());

describe("cityPlaces (tour suggestions and sights)", () => {
  it("cached places: keys, localized names and categories, 0 network calls", async () => {
    h.impl = (o) => (o.provider === "overpass" ? ok([candidate]) : ok([]));
    const r = await cityPlaces(dest, ["general"], { userId: "u1", locale: "en", network: true });
    expect(r).toEqual({
      places: [{ key: "osm:w212496461", name: "St. Stephen's Cathedral", lat: 48.2085, lon: 16.3731, cat: "place_of_worship", url: candidate.osmUrl }],
      pending: false,
      fetchedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  it("never queries Overpass over the network, even when nothing is cached; the lookup is queued instead", async () => {
    h.impl = (o) => (o.provider === "overpass" ? { ok: false, error: "timeout" } : { ok: false, error: "provider_error" });
    const r = await cityPlaces(dest, ["general"], { userId: "u1", locale: "de", network: true });
    expect(r).toMatchObject({ places: [], pending: true });
    expect(h.calls.filter((c) => c.provider === "overpass").every((c) => c.fetchAllowed?.() === false)).toBe(true);
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0][0][0]).toMatchObject({ kind: "interest", params: { interest: "general", lat: 48.208, lon: 16.372 } });
  });

  it("network: false allows no Geoapify fetch either (cache only)", async () => {
    h.impl = () => ({ ok: false, error: "timeout" });
    await cityPlaces(dest, ["general"], { userId: "u1", locale: "de", network: false });
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.calls.every((c) => c.fetchAllowed?.() === false)).toBe(true);
  });
});
