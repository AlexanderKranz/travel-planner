import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Opts = {
  provider: string;
  endpoint: string;
  key: string;
  schema: { parse: (v: unknown) => unknown };
  fetchAllowed?: () => boolean;
  fetcher: () => Promise<{ data: unknown; units?: number; variant?: string }>;
};
const h = vi.hoisted(() => ({
  calls: [] as { provider: string; key: string; allowed: boolean }[],
  /** Providers whose cached() call answers a cache hit (data from the fetcher) without the network gate. */
  hits: new Set<string>(),
  runQuery: vi.fn(),
  fetchPlaces: vi.fn(),
}));
vi.mock("../api-cache", () => ({
  cacheKey: (e: string, v: number, p: Record<string, string | number>) => `${e}:v${v}:${JSON.stringify(p)}`,
  cached: async (o: Opts) => {
    const allowed = o.fetchAllowed ? o.fetchAllowed() : true;
    h.calls.push({ provider: o.provider, key: o.key, allowed });
    if (h.hits.has(o.provider)) {
      const r = await o.fetcher();
      return { ok: true, data: o.schema.parse(r.data), fetchedAt: "2026-11-06T00:00:00.000Z", stale: false, cache: "hit" };
    }
    if (!allowed) return { ok: false, error: "timeout" };
    try {
      const r = await o.fetcher();
      return { ok: true, data: o.schema.parse(r.data), fetchedAt: "2026-11-06T00:00:00.000Z", stale: false, cache: "miss" };
    } catch {
      return { ok: false, error: "provider_error" };
    }
  },
}));
vi.mock("./geoapify-quota", () => ({ assertGeoapifyQuota: async () => {} }));
vi.mock("@/lib/integrations/geoapify", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/geoapify")>()),
  fetchPlaces: h.fetchPlaces,
}));
vi.mock("@/lib/integrations/overpass", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/overpass")>()),
  runQuery: h.runQuery,
}));

import { parseElements, buildQuery } from "@/lib/integrations/overpass";
import { getActivityGroupFacts, getRestaurantFacts, RESTAURANT_POOL } from "./activities";
import type { GeoDestination } from "./common";

const fixture = (f: string) =>
  parseElements(JSON.parse(readFileSync(new URL(`../../integrations/__fixtures__/overpass/${f}`, import.meta.url), "utf8")));
const ctx = { userId: null, locale: "de" as const, today: "2026-11-06" };
const dest = (kind: "city" | "region"): GeoDestination => ({
  kind, name: "Würzburg", placeName: "Würzburg", geoId: 1, countryCode: "DE", admin1: null, lat: 49.7913, lon: 9.9534, timezone: "Europe/Berlin", radiusKm: 15,
});
const overpassAnswer = (f: string) => ({ elements: fixture(f), status: 200, latencyMs: 10, mirror: "overpass-api.de" });

beforeEach(() => {
  h.calls = [];
  h.hits.clear();
  h.runQuery.mockReset();
  h.fetchPlaces.mockReset();
  vi.stubEnv("GEOAPIFY_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("getActivityGroupFacts", () => {
  it("one union Overpass query for the group; typed, validated places", async () => {
    h.runQuery.mockResolvedValue(overpassAnswer("indoor-wuerzburg-15km.json"));
    const f = await getActivityGroupFacts("indoor", dest("city"), ctx);
    expect(h.runQuery).toHaveBeenCalledTimes(1);
    const q = h.runQuery.mock.calls[0][0] as string;
    for (const tag of ["escape_game", "bowling_alley", "cinema", "theatre", "karaoke_box", "climbing"]) expect(q).toContain(tag);
    expect(q).toContain('["name"]');
    expect(f.status).toBe("ok");
    if (f.status !== "ok") return;
    expect(f.source).toBe("osm");
    expect(f.data.group).toBe("indoor");
    expect(f.data.radiusKm).toBe(15);
    expect(f.data.places.some((p) => p.type === "escape_game")).toBe(true);
    // cache probe (no network) first, then the real query
    expect(h.calls.map((c) => `${c.provider}:${c.allowed}`)).toEqual(["overpass:false", "overpass:true"]);
  });

  it("a cached Overpass result is served without any query", async () => {
    h.hits.add("overpass");
    h.runQuery.mockResolvedValue(overpassAnswer("indoor-wuerzburg-15km.json"));
    const f = await getActivityGroupFacts("indoor", dest("city"), ctx, { budgetMs: 0 });
    expect(f.status).toBe("ok");
    expect(h.calls).toHaveLength(1);
  });

  it("budget 0 = cache only: no network, unavailable", async () => {
    const f = await getActivityGroupFacts("outdoor", dest("city"), ctx, { budgetMs: 0 });
    expect(f).toMatchObject({ status: "unavailable", reason: "provider_error" });
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(h.fetchPlaces).not.toHaveBeenCalled();
  });

  it("going_out is fully mapped: Geoapify first (filters applied in code), Overpass not queried", async () => {
    vi.stubEnv("GEOAPIFY_API_KEY", "k");
    h.fetchPlaces.mockResolvedValue({
      elements: [
        { type: "node", id: 1, lat: 49.792, lon: 9.954, tags: { name: "Hofbräu Bar", amenity: "bar" } },
        { type: "node", id: 2, lat: 49.793, lon: 9.955, tags: { name: "Kiosk", amenity: "fast_food" } },
      ],
      status: 200, latencyMs: 5, credits: 1,
    });
    const f = await getActivityGroupFacts("going_out", dest("city"), ctx);
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(h.fetchPlaces.mock.calls[0][0]).toEqual([["catering.bar", "catering.pub", "catering.biergarten"]]);
    expect(f.status === "ok" && f.data.places.map((p) => p.name)).toEqual(["Hofbräu Bar"]);
  });

  it("indoor has an unmapped type (karaoke): Geoapify is not used even with a key", async () => {
    vi.stubEnv("GEOAPIFY_API_KEY", "k");
    h.runQuery.mockResolvedValue(overpassAnswer("indoor-wuerzburg-15km.json"));
    await getActivityGroupFacts("indoor", dest("city"), ctx);
    expect(h.fetchPlaces).not.toHaveBeenCalled();
    expect(h.calls.some((c) => c.provider === "geoapify")).toBe(false);
  });

  it("Overpass failure is unavailable, not a throw", async () => {
    h.runQuery.mockRejectedValue(new Error("boom"));
    expect((await getActivityGroupFacts("indoor", dest("city"), ctx)).status).toBe("unavailable");
  });
});

describe("getRestaurantFacts", () => {
  it("city: 2.5 km, bbox query with a raised element cap, unfiltered nearest pool", async () => {
    h.runQuery.mockResolvedValue(overpassAnswer("restaurants-wuerzburg-2.5km.json"));
    const f = await getRestaurantFacts(dest("city"), ctx);
    const q = h.runQuery.mock.calls[0][0] as string;
    expect(q).toContain('nwr["amenity"="restaurant"]["name"]');
    expect(q).toContain("out center tags 500;");
    expect(f.status).toBe("ok");
    if (f.status !== "ok") return;
    expect(f.data.radiusKm).toBe(2.5);
    expect(f.data.restaurants.length).toBeGreaterThan(100);
    expect(f.data.restaurants.length).toBeLessThanOrEqual(RESTAURANT_POOL);
    const d = f.data.restaurants.map((r) => r.distanceKm);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    expect(h.calls.find((c) => c.provider === "overpass")!.key).toContain('"r":2.5');
  });

  it("region: 5 km", async () => {
    h.runQuery.mockResolvedValue({ elements: [], status: 200, latencyMs: 1, mirror: "m" });
    const f = await getRestaurantFacts(dest("region"), ctx);
    expect(f.status === "ok" && f.data.radiusKm).toBe(5);
    expect(h.runQuery.mock.calls[0][0]).toBe(buildQuery(['["amenity"="restaurant"]'], { lat: 49.791, lon: 9.953 }, 5000, 500));
  });

  it("with a Geoapify key it answers first (catering.restaurant) and keeps only restaurants", async () => {
    vi.stubEnv("GEOAPIFY_API_KEY", "k");
    h.fetchPlaces.mockResolvedValue({
      elements: [
        { type: "node", id: 1, lat: 49.7915, lon: 9.9536, tags: { name: "Ratskeller", amenity: "restaurant", cuisine: "regional" } },
      ],
      status: 200, latencyMs: 5, credits: 1,
    });
    const f = await getRestaurantFacts(dest("city"), ctx);
    expect(h.fetchPlaces.mock.calls[0][0]).toEqual([["catering.restaurant"]]);
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(f.status === "ok" && f.data.restaurants[0]).toMatchObject({ name: "Ratskeller", cuisines: ["regional"] });
  });

  it("Geoapify failure falls back to Overpass", async () => {
    vi.stubEnv("GEOAPIFY_API_KEY", "k");
    h.fetchPlaces.mockRejectedValue(new Error("quota"));
    h.runQuery.mockResolvedValue(overpassAnswer("restaurants-wuerzburg-2.5km.json"));
    const f = await getRestaurantFacts(dest("city"), ctx);
    expect(f.status).toBe("ok");
    expect(h.runQuery).toHaveBeenCalledTimes(1);
  });
});
