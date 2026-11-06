import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Opts = {
  provider: string;
  key: string;
  schema: { parse: (v: unknown) => unknown };
  fetchAllowed?: () => boolean;
  fetcher: () => Promise<{ data: unknown; units?: number; variant?: string }>;
};
type Entry = { data: unknown; expired: boolean };
const h = vi.hoisted(() => ({
  calls: [] as { provider: string; key: string; allowed: boolean | null; units?: number }[],
  /** Errors a fetcher threw (the real cached() reads `units` from them for the quota). */
  errors: [] as unknown[],
  /** Fake api_cache per provider: a fresh entry is a hit (fetcher not called), an expired one is served stale on failure. */
  store: new Map<string, { data: unknown; expired: boolean }>(),
  /** Providers whose cached() fails in its outer catch without running the fetcher. */
  broken: new Set<string>(),
  events: [] as { event: string; props?: Record<string, unknown> }[],
  runQuery: vi.fn(),
  fetchPlaces: vi.fn(),
}));
vi.mock("../api-cache", () => ({
  cacheKey: (e: string, v: number, p: Record<string, string | number>) => `${e}:v${v}:${JSON.stringify(p)}`,
  // Mirrors the real cached(): fresh row = hit without a fetch, gate checked only after that, failure = stale row or error.
  cached: async (o: Opts) => {
    // Exact row first (written by an earlier miss); else a seeded row: `provider` = any key, `provider#text` = keys containing text.
    const seeded = [...h.store].find(([k]) => k.startsWith(`${o.provider}#`) && !k.startsWith(`${o.provider}#{`) && o.key.includes(k.slice(o.provider.length + 1)));
    const entry = (h.store.get(`${o.provider}#${o.key}`) ?? seeded?.[1] ?? h.store.get(o.provider)) as Entry | undefined;
    const call = { provider: o.provider, key: o.key, allowed: null as boolean | null };
    h.calls.push(call);
    if (h.broken.has(o.provider)) return { ok: false, error: "provider_error" };
    if (entry && !entry.expired) return { ok: true, data: entry.data, fetchedAt: "2026-11-06T00:00:00.000Z", stale: false, cache: "hit" };
    if (o.fetchAllowed) {
      call.allowed = o.fetchAllowed();
      if (!call.allowed) {
        return entry ? { ok: true, data: entry.data, fetchedAt: "2026-10-01T00:00:00.000Z", stale: true, cache: "stale" } : { ok: false, error: "timeout" };
      }
    }
    try {
      const r = await o.fetcher();
      call.units = r.units;
      const data = o.schema.parse(r.data);
      h.store.set(`${o.provider}#${o.key}`, { data, expired: false });
      return { ok: true, data, fetchedAt: "2026-11-06T00:00:00.000Z", stale: false, cache: "miss" };
    } catch (err) {
      h.errors.push(err);
      return entry ? { ok: true, data: entry.data, fetchedAt: "2026-10-01T00:00:00.000Z", stale: true, cache: "stale" } : { ok: false, error: "provider_error" };
    }
  },
}));
vi.mock("../events", () => ({ logEvent: async (e: { event: string; props?: Record<string, unknown> }) => void h.events.push(e) }));
vi.mock("./geoapify-quota", () => ({ assertGeoapifyQuota: async () => {} }));
vi.mock("@/lib/integrations/geoapify", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/geoapify")>()),
  fetchPlaces: h.fetchPlaces,
}));
vi.mock("@/lib/integrations/overpass", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/overpass")>()),
  runQuery: h.runQuery,
}));

import { ACTIVITY_SOURCES } from "@/lib/facts/activity-types";
import { parseElements, buildQuery } from "@/lib/integrations/overpass";
import {
  GEOAPIFY_RESTAURANT_LIMIT,
  OVERPASS_LIMIT,
  RESTAURANT_NEAR_RADIUS_KM,
  RESTAURANT_POOL,
  CAFE_POOL,
  getActivityGroupFacts,
  getCafeFacts,
  getRestaurantFacts,
  mergeGroupParts,
} from "./activities";
import type { GeoDestination } from "./common";

const fixture = (f: string) =>
  parseElements(JSON.parse(readFileSync(new URL(`../../integrations/__fixtures__/overpass/${f}`, import.meta.url), "utf8")));
const ctx = { userId: null, locale: "de" as const, today: "2026-11-06" };
const dest = (kind: "city" | "region"): GeoDestination => ({
  kind, name: "Würzburg", placeName: "Würzburg", geoId: 1, countryCode: "DE", admin1: null, lat: 49.7913, lon: 9.9534, timezone: "Europe/Berlin", radiusKm: 15,
});
const overpassAnswer = (f: string) => ({ elements: fixture(f), status: 200, latencyMs: 10, mirror: "overpass-api.de" });
const geoBar = {
  elements: [
    { type: "node", id: 1, lat: 49.792, lon: 9.954, tags: { name: "Hofbräu Bar", amenity: "bar" } },
    { type: "node", id: 2, lat: 49.793, lon: 9.955, tags: { name: "Kiosk", amenity: "fast_food" } },
  ],
  status: 200, latencyMs: 5, credits: 1, truncated: false,
};
/** An answer that reaches the query cap with elements that match nothing (a dense city, the wanted place cut off). */
const cappedAnswer = () => ({
  elements: Array.from({ length: OVERPASS_LIMIT }, (_, i) => ({ type: "node" as const, id: i + 1, lat: 49.79, lon: 9.95, tags: { name: `x${i}`, amenity: "cafe" } })),
  status: 200, latencyMs: 1, mirror: "m",
});
const freshOverpass = (items: unknown[], truncated = false) => h.store.set("overpass", { data: { items, truncated }, expired: false });

beforeEach(() => {
  h.calls = [];
  h.errors = [];
  h.store.clear();
  h.broken.clear();
  h.events = [];
  h.runQuery.mockReset();
  h.fetchPlaces.mockReset();
  vi.stubEnv("GEOAPIFY_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("getActivityGroupFacts", () => {
  it("one union Overpass query for the group, a name on every line, raised cap; typed places", async () => {
    h.runQuery.mockResolvedValue(overpassAnswer("indoor-wuerzburg-15km.json"));
    const f = await getActivityGroupFacts("indoor", dest("city"), ctx);
    expect(h.runQuery).toHaveBeenCalledTimes(1);
    const q = h.runQuery.mock.calls[0][0] as string;
    const lines = q.split("\n").filter((l) => l.startsWith("  nwr"));
    expect(lines.length).toBe(11); // escape_game, bowling, cinema, theatre, karaoke, climbing_hall x2, indoor_play, swimming x3
    for (const l of lines) expect(l).toContain('["name"]');
    expect(q).toContain(`out center tags ${OVERPASS_LIMIT};`);
    expect(f.status).toBe("ok");
    if (f.status !== "ok") return;
    expect(f.source).toBe("osm");
    expect(f.data).toMatchObject({ group: "indoor", radiusKm: 15, truncated: false });
    expect(f.data.places.some((p) => p.types.includes("escape_game"))).toBe(true);
    expect(h.calls.map((c) => `${c.provider}:${c.allowed}`)).toEqual(["overpass:false", "overpass:true"]);
    expect(h.calls[0].key).toContain("interpreter:v4:");
  });

  it("a cached result is served without a query (the fetcher is not run on a hit)", async () => {
    freshOverpass([]);
    const f = await getActivityGroupFacts("indoor", dest("city"), ctx, { budgetMs: 0 });
    expect(f.status).toBe("empty");
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
  });

  it("budget 0 = cache only: nothing cached is skipped, not error", async () => {
    const f = await getActivityGroupFacts("outdoor", dest("city"), ctx, { budgetMs: 0 });
    expect(f).toEqual({ status: "skipped", reason: "cache_only" });
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(h.fetchPlaces).not.toHaveBeenCalled();
  });

  it("going_out is fully mapped: Geoapify first (filters applied in code), Overpass not queried", async () => {
    vi.stubEnv("GEOAPIFY_API_KEY", "k");
    h.fetchPlaces.mockResolvedValue(geoBar);
    const f = await getActivityGroupFacts("going_out", dest("city"), ctx);
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(h.fetchPlaces.mock.calls[0][0]).toEqual([["catering.bar", "catering.pub", "catering.biergarten"]]);
    expect(f.status === "ok" && f.data.places.map((p) => p.name)).toEqual(["Hofbräu Bar"]);
  });

  it("a complete lookup without a match is empty", async () => {
    h.runQuery.mockResolvedValue({ elements: [], status: 200, latencyMs: 1, mirror: "m" });
    expect(await getActivityGroupFacts("outdoor", dest("city"), ctx)).toMatchObject({ status: "empty", data: { places: [], truncated: false } });
  });

  it("an answer that hits the query cap is ok + truncated, never empty, and is logged", async () => {
    h.runQuery.mockResolvedValue(cappedAnswer());
    const f = await getActivityGroupFacts("indoor", dest("city"), ctx);
    expect(f).toMatchObject({ status: "ok", data: { places: [], truncated: true } });
    expect(h.events).toMatchObject([{ event: "places.truncated", props: { kind: "activities:indoor", source: "overpass", limit: OVERPASS_LIMIT } }]);
    // the flag is part of what is cached: a later hit still says truncated
    h.runQuery.mockClear();
    expect(await getActivityGroupFacts("indoor", dest("city"), ctx)).toMatchObject({ status: "ok", data: { truncated: true } });
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  it("a Geoapify page at its limit is truncated too", async () => {
    vi.stubEnv("GEOAPIFY_API_KEY", "k");
    h.fetchPlaces.mockResolvedValue({ ...geoBar, elements: [], truncated: true });
    expect(await getActivityGroupFacts("going_out", dest("city"), ctx)).toMatchObject({ status: "ok", data: { places: [], truncated: true } });
    expect(h.events[0]).toMatchObject({ event: "places.truncated", props: { source: "geoapify" } });
  });

  it("Overpass failure is error", async () => {
    h.runQuery.mockRejectedValue(new Error("boom"));
    expect((await getActivityGroupFacts("indoor", dest("city"), ctx)).status).toBe("error");
  });

  it("Geoapify fails, then the Overpass gate denies (budget): error, not skipped", async () => {
    vi.stubEnv("GEOAPIFY_API_KEY", "k");
    h.fetchPlaces.mockRejectedValue(new Error("quota"));
    const f = await getActivityGroupFacts("going_out", dest("city"), ctx, { budgetMs: 30_000 });
    expect(f).toEqual({ status: "error", source: "osm" });
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(h.calls.map((c) => `${c.provider}:${c.allowed}`)).toEqual(["overpass:false", "geoapify:true", "overpass:false"]);
  });

  it("both providers fail: error", async () => {
    vi.stubEnv("GEOAPIFY_API_KEY", "k");
    h.fetchPlaces.mockRejectedValue(new Error("5xx"));
    h.runQuery.mockRejectedValue(new Error("502"));
    expect((await getActivityGroupFacts("going_out", dest("city"), ctx)).status).toBe("error");
  });

  it("cached() failing without running a fetcher is error, not skipped", async () => {
    h.broken.add("overpass");
    expect(await getActivityGroupFacts("indoor", dest("city"), ctx)).toEqual({ status: "error", source: "osm" });
    expect(h.runQuery).not.toHaveBeenCalled();
  });

  it("an expired result is served stale when the refresh fails", async () => {
    h.store.set("overpass", { data: { items: [], truncated: false }, expired: true });
    h.runQuery.mockRejectedValue(new Error("502"));
    expect(await getActivityGroupFacts("outdoor", dest("city"), ctx)).toMatchObject({ status: "empty", stale: true });
  });

  it("an expired Overpass result still wins when Geoapify and the Overpass refresh both fail", async () => {
    vi.stubEnv("GEOAPIFY_API_KEY", "k");
    h.store.set("overpass", { data: { items: [], truncated: false }, expired: true });
    h.fetchPlaces.mockRejectedValue(new Error("quota"));
    h.runQuery.mockRejectedValue(new Error("502"));
    expect(await getActivityGroupFacts("going_out", dest("city"), ctx)).toMatchObject({ status: "empty", stale: true });
  });

  it("no coordinates = skipped, nothing fetched", async () => {
    expect(await getActivityGroupFacts("indoor", null, ctx)).toEqual({ status: "skipped", reason: "no_location" });
    expect(await getRestaurantFacts(null, ctx)).toEqual({ status: "skipped", reason: "no_location" });
    expect(h.calls).toHaveLength(0);
  });
});

describe("getRestaurantFacts", () => {
  it("city: 2.5 km, raised element cap, unfiltered nearest pool", async () => {
    h.runQuery.mockResolvedValue(overpassAnswer("restaurants-wuerzburg-2.5km.json"));
    const f = await getRestaurantFacts(dest("city"), ctx);
    const q = h.runQuery.mock.calls[0][0] as string;
    expect(q).toContain('nwr["amenity"="restaurant"]["name"]');
    expect(q).toContain(`out center tags ${OVERPASS_LIMIT};`);
    expect(f.status).toBe("ok");
    if (f.status !== "ok") return;
    expect(f.data.radiusKm).toBe(2.5);
    expect(f.data.truncated).toBe(false);
    expect(f.data.restaurants.length).toBeGreaterThan(100);
    expect(f.data.restaurants.length).toBeLessThanOrEqual(RESTAURANT_POOL);
    const d = f.data.restaurants.map((r) => r.distanceKm);
    expect([...d].sort((a, b) => a - b)).toEqual(d);
    expect(h.calls.find((c) => c.provider === "overpass")!.key).toContain('"r":2.5');
  });

  it("an Overpass answer at the cap: the nearest of what came back, flagged truncated", async () => {
    const far = Array.from({ length: OVERPASS_LIMIT }, (_, i) => ({
      type: "node" as const, id: i + 1, lat: 49.7913 + (i % 200) * 0.0001, lon: 9.9534, tags: { name: `R${i}`, amenity: "restaurant" },
    }));
    h.runQuery.mockResolvedValue({ elements: far, status: 200, latencyMs: 1, mirror: "m" });
    const f = await getRestaurantFacts(dest("city"), ctx);
    expect(f.status === "ok" && f.data.truncated).toBe(true);
    if (f.status !== "ok") return;
    expect(f.data.restaurants).toHaveLength(RESTAURANT_POOL);
    expect(f.data.restaurants[0].distanceKm).toBeLessThanOrEqual(f.data.restaurants[RESTAURANT_POOL - 1].distanceKm);
  });

  it("region: 5 km", async () => {
    h.runQuery.mockResolvedValue({ elements: [], status: 200, latencyMs: 1, mirror: "m" });
    const f = await getRestaurantFacts(dest("region"), ctx);
    expect(f.status === "empty" && f.data.radiusKm).toBe(5);
    expect(h.runQuery.mock.calls[0][0]).toBe(buildQuery(['["amenity"="restaurant"]'], { lat: 49.791, lon: 9.953 }, 5000, OVERPASS_LIMIT));
  });

  it("with a Geoapify key it answers first with a page larger than the pool, and keeps only restaurants", async () => {
    vi.stubEnv("GEOAPIFY_API_KEY", "k");
    h.fetchPlaces.mockResolvedValue({
      elements: [
        { type: "node", id: 1, lat: 49.7915, lon: 9.9536, tags: { name: "Ratskeller", amenity: "restaurant", cuisine: "regional" } },
        { type: "node", id: 2, lat: 49.7915, lon: 9.9536, tags: { name: "Kiosk", amenity: "fast_food" } },
      ],
      status: 200, latencyMs: 5, credits: 1, truncated: false,
    });
    const f = await getRestaurantFacts(dest("city"), ctx);
    expect(h.fetchPlaces.mock.calls[0][0]).toEqual([["catering.restaurant"]]);
    expect(h.fetchPlaces.mock.calls[0][3]).toBe(GEOAPIFY_RESTAURANT_LIMIT);
    expect(GEOAPIFY_RESTAURANT_LIMIT).toBeGreaterThan(RESTAURANT_POOL);
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(f.status === "ok" && f.data.restaurants).toMatchObject([{ name: "Ratskeller", cuisines: ["regional"] }]);
  });

  it("Geoapify failure falls back to Overpass", async () => {
    vi.stubEnv("GEOAPIFY_API_KEY", "k");
    h.fetchPlaces.mockRejectedValue(new Error("quota"));
    h.runQuery.mockResolvedValue(overpassAnswer("restaurants-wuerzburg-2.5km.json"));
    expect((await getRestaurantFacts(dest("city"), ctx)).status).toBe("ok");
    expect(h.runQuery).toHaveBeenCalledTimes(1);
  });

  it("near: 1.5 km around the given point, cache key = rounded point + radius; works without a destination", async () => {
    h.runQuery.mockResolvedValue(overpassAnswer("restaurants-wuerzburg-2.5km.json"));
    const f = await getRestaurantFacts(null, ctx, { near: { lat: 49.79234, lon: 9.95391 } });
    expect(f.status).toBe("ok");
    if (f.status !== "ok") return;
    expect(f.data.radiusKm).toBe(RESTAURANT_NEAR_RADIUS_KM);
    expect(f.data.restaurants.every((r) => r.distanceKm <= 1.5)).toBe(true);
    const key = h.calls.find((c) => c.provider === "overpass")!.key;
    expect(key).toContain('"lat":49.792');
    expect(key).toContain('"lon":9.954');
    expect(key).toContain('"r":1.5');
  });
});

const cafeOverpass = (...extra: { id: number; tags: Record<string, string>; lat?: number }[]) => ({
  elements: [
    { type: "node" as const, id: 1, lat: 49.7915, lon: 9.9536, tags: { name: "Café Central", amenity: "cafe", website: "https://c.test", opening_hours: "Mo-Su 09:00-18:00" } },
    { type: "node" as const, id: 2, lat: 49.7916, lon: 9.9537, tags: { name: "Kinder Café", amenity: "cafe", kids_area: "yes" } },
    { type: "node" as const, id: 3, lat: 49.7917, lon: 9.9538, tags: { amenity: "cafe" } }, // unnamed
    { type: "node" as const, id: 4, lat: 49.7918, lon: 9.9539, tags: { name: "Restaurant", amenity: "restaurant" } },
    ...extra.map((e) => ({ type: "node" as const, id: e.id, lat: e.lat ?? 49.7915, lon: 9.9536, tags: e.tags })),
  ],
  status: 200, latencyMs: 5, mirror: "overpass-api.de",
});

describe("getCafeFacts", () => {
  it("named amenity=cafe only, 2.5 km city, own versioned cache key, kidsTagged parsed", async () => {
    h.runQuery.mockResolvedValue(cafeOverpass());
    const f = await getCafeFacts(dest("city"), ctx);
    expect(h.runQuery.mock.calls[0][0]).toContain('nwr["amenity"="cafe"]["name"]');
    expect(f.status).toBe("ok");
    if (f.status !== "ok") return;
    expect(f).toMatchObject({ source: "osm", stale: false });
    expect(f.data).toMatchObject({ radiusKm: 2.5, truncated: false });
    expect(f.data.cafes.map((c) => [c.name, c.kidsTagged])).toEqual([["Café Central", false], ["Kinder Café", true]]);
    const key = h.calls.find((c) => c.provider === "overpass")!.key;
    expect(key).toContain("interpreter:v3:");
    expect(key).toContain('"kind":"cafes"');
  });
  it("region 5 km; near 1.5 km works without a destination", async () => {
    h.runQuery.mockResolvedValue({ elements: [], status: 200, latencyMs: 1, mirror: "m" });
    const r = await getCafeFacts(dest("region"), ctx);
    expect(r.status === "empty" && r.data.radiusKm).toBe(5);
    const n = await getCafeFacts(null, ctx, { near: { lat: 49.79234, lon: 9.95391 } });
    expect(n.status === "empty" && n.data.radiusKm).toBe(1.5);
    expect(h.calls.map((c) => c.key).at(-1)).toContain('"lat":49.792');
  });
  it("pool is capped at the nearest CAFE_POOL", async () => {
    const many = Array.from({ length: CAFE_POOL + 20 }, (_, i) => ({ id: 100 + i, lat: 49.7913 + i * 0.00005, tags: { name: `C${i}`, amenity: "cafe" } }));
    h.runQuery.mockResolvedValue(cafeOverpass(...many));
    const f = await getCafeFacts(dest("city"), ctx);
    expect(f.status === "ok" && f.data.cafes).toHaveLength(CAFE_POOL);
  });
  it("empty: a complete lookup without a café", async () => {
    h.runQuery.mockResolvedValue({ elements: [], status: 200, latencyMs: 1, mirror: "m" });
    expect(await getCafeFacts(dest("city"), ctx)).toMatchObject({ status: "empty", data: { cafes: [], truncated: false } });
  });
  it("a capped answer with no café is ok + truncated, never empty", async () => {
    h.runQuery.mockResolvedValue(cappedAnswer());
    const f = await getCafeFacts(dest("city"), ctx);
    expect(f).toMatchObject({ status: "ok", data: { truncated: true } });
    expect(h.events.some((e) => e.event === "places.truncated" && e.props?.kind === "cafes")).toBe(true);
  });
  it("error when the fetch fails; skipped without a point and when cache-only with nothing cached", async () => {
    h.runQuery.mockRejectedValue(new Error("down"));
    expect(await getCafeFacts(dest("city"), ctx)).toEqual({ status: "error", source: "osm" });
    expect(await getCafeFacts(null, ctx)).toEqual({ status: "skipped", reason: "no_location" });
    h.runQuery.mockClear();
    expect(await getCafeFacts(dest("city"), ctx, { budgetMs: 0 })).toEqual({ status: "skipped", reason: "cache_only" });
    expect(h.runQuery).not.toHaveBeenCalled();
  });
  it("a fresh cached batch is served without a query; Geoapify answers with the cafe category when keyed", async () => {
    freshOverpass([]);
    expect(await getCafeFacts(dest("city"), ctx)).toMatchObject({ status: "empty" });
    expect(h.runQuery).not.toHaveBeenCalled();
    h.store.clear();
    vi.stubEnv("GEOAPIFY_API_KEY", "k");
    h.fetchPlaces.mockResolvedValue({
      elements: [
        { type: "node", id: 1, lat: 49.7915, lon: 9.9536, tags: { name: "Bohne", amenity: "cafe" } },
        { type: "node", id: 2, lat: 49.7915, lon: 9.9536, tags: { name: "Eis", amenity: "ice_cream" } },
      ],
      status: 200, latencyMs: 5, credits: 1, truncated: false,
    });
    const f = await getCafeFacts(dest("city"), ctx);
    expect(h.fetchPlaces.mock.calls[0][0]).toEqual([["catering.cafe"]]);
    expect(f.status === "ok" && f.data.cafes.map((c) => c.name)).toEqual(["Bohne"]);
  });
});

describe("per-line radius in the group union", () => {
  it("outdoor: playground lines use 3 km, the other types their own radius", async () => {
    h.runQuery.mockResolvedValue({ elements: [], status: 200, latencyMs: 1, mirror: "m" });
    await getActivityGroupFacts("outdoor", dest("city"), ctx);
    const q = h.runQuery.mock.calls[0][0] as string;
    const lines = q.split("\n").filter((l) => l.startsWith("  nwr"));
    const south = (l: string) => Number(/\(([-\d.]+),/.exec(l)![1]);
    const halfHeightKm = (l: string) => (49.791 - south(l)) * 111.32;
    const playground = lines.find((l) => l.includes('"playground"'))!;
    const rowing = lines.find((l) => l.includes("rowing"))!;
    const minigolf = lines.find((l) => l.includes("miniature_golf"))!;
    expect(halfHeightKm(playground)).toBeCloseTo(3, 0);
    expect(halfHeightKm(rowing)).toBeCloseTo(25, 0);
    expect(halfHeightKm(minigolf)).toBeCloseTo(15, 0);
  });
});

describe("split lookup per source", () => {
  const geoNode = (id: number, tags: Record<string, string>) => ({ type: "node" as const, id, lat: 49.792, lon: 9.954, tags: { name: `p${id}`, ...tags } });
  /** Answers per Geoapify category list: the first category decides the elements. */
  const geoByCategory = (byCat: Record<string, ReturnType<typeof geoNode>[]>, extra: Record<string, object> = {}) =>
    h.fetchPlaces.mockImplementation(async (groups: string[][]) => ({
      elements: byCat[groups[0][0]] ?? [], status: 200, latencyMs: 5, credits: 1, truncated: false, ...extra[groups[0][0]],
    }));
  const opLines = () => (h.runQuery.mock.calls[0][0] as string).split("\n").filter((l) => l.startsWith("  nwr"));
  const emptyOverpass = { elements: [], status: 200, latencyMs: 1, mirror: "m" };
  beforeEach(() => vi.stubEnv("GEOAPIFY_API_KEY", "k"));

  it("indoor: one Geoapify request per mapped type with its own radius, Overpass only for the unmapped types", async () => {
    geoByCategory({ "entertainment.escape_game": [geoNode(1, { leisure: "escape_game" })], "entertainment.cinema": [geoNode(2, { amenity: "cinema" })] });
    h.runQuery.mockResolvedValue({ elements: [geoNode(3, { amenity: "karaoke_box" })], status: 200, latencyMs: 1, mirror: "m" });
    const f = await getActivityGroupFacts("indoor", dest("city"), ctx);
    expect(h.fetchPlaces.mock.calls.map((c) => c[0])).toEqual([
      [["entertainment.escape_game"]],
      [["entertainment.bowling_alley"]],
      [["entertainment.cinema"]],
      [["entertainment.culture.theatre"]],
      [["entertainment.activity_park.climbing"]],
      [["sport.swimming_pool", "sport.sports_centre", "entertainment.water_park", "leisure.spa.public_bath"]],
    ]);
    expect(h.fetchPlaces.mock.calls.map((c) => c[2])).toEqual([10000, 10000, 10000, 10000, 15000, 15000]);
    expect(h.runQuery).toHaveBeenCalledTimes(1);
    const lines = opLines();
    expect(lines.length).toBe(2); // karaoke, indoor_play
    expect(lines.join()).not.toMatch(/cinema|escape_game|bowling|theatre|swimming|water_park|public_bath|climbing/);
    expect(f.status).toBe("ok");
    if (f.status !== "ok") return;
    expect(f.data.partial).toBe(false);
    expect(f.data.places.map((p) => p.types[0]).sort()).toEqual(["cinema", "escape_game", "karaoke"]);
    expect(f.data.typeStatus).toMatchObject({
      escape_game: "ok", cinema: "ok", karaoke: "ok", bowling: "empty", theatre: "empty", swimming: "empty", climbing_hall: "empty", indoor_play: "empty",
    });
  });

  it("outdoor: boat rental, minigolf and playground (3 km) via Geoapify, the other five types via Overpass", async () => {
    geoByCategory({});
    h.runQuery.mockResolvedValue(emptyOverpass);
    await getActivityGroupFacts("outdoor", dest("city"), ctx);
    expect(h.fetchPlaces.mock.calls.map((c) => [c[0][0][0], c[2]])).toEqual([
      ["rental.boat", 25000],
      ["entertainment.miniature_golf", 15000],
      ["leisure.playground", 3000],
    ]);
    expect(opLines().length).toBe(5);
  });

  it("cache keys: versioned, one per part and provider; the keyless lookup has its own all-types key", async () => {
    geoByCategory({});
    h.runQuery.mockResolvedValue(emptyOverpass);
    await getActivityGroupFacts("indoor", dest("city"), ctx);
    const geo = h.calls.filter((c) => c.provider === "geoapify");
    expect(geo).toHaveLength(1);
    expect(geo[0].key).toMatch(/^places:v4:.*"part":"geo","t":"escape_game,bowling,cinema,theatre,climbing_hall,swimming"/);
    const op = h.calls.filter((c) => c.provider === "overpass");
    expect(op.every((c) => c.key.startsWith("interpreter:v4:"))).toBe(true);
    expect(op.some((c) => c.key.includes('"part":"osm","t":"karaoke,indoor_play"'))).toBe(true);
    vi.stubEnv("GEOAPIFY_API_KEY", "");
    h.calls = [];
    await getActivityGroupFacts("indoor", dest("city"), ctx);
    expect(h.calls.every((c) => c.key.includes('"part":"osm","t":"escape_game,bowling,cinema,theatre,karaoke,climbing_hall,indoor_play,swimming"'))).toBe(true);
  });

  it("both parts cached: a later cache-only lookup is served from the two rows, nothing is fetched", async () => {
    geoByCategory({ "entertainment.cinema": [geoNode(2, { amenity: "cinema" })] });
    h.runQuery.mockResolvedValue(emptyOverpass);
    await getActivityGroupFacts("indoor", dest("city"), ctx);
    h.fetchPlaces.mockClear();
    h.runQuery.mockClear();
    const f = await getActivityGroupFacts("indoor", dest("city"), ctx, { budgetMs: 0 });
    expect(h.fetchPlaces).not.toHaveBeenCalled();
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(f).toMatchObject({ status: "ok", data: { partial: false, typeStatus: { cinema: "ok", karaoke: "empty" } } });
  });

  it("Overpass part fails, Geoapify part ok: the Geoapify places stay, only the Overpass-only types are error", async () => {
    geoByCategory({ "entertainment.cinema": [geoNode(2, { amenity: "cinema" })] });
    h.runQuery.mockRejectedValue(new Error("504"));
    const f = await getActivityGroupFacts("indoor", dest("city"), ctx);
    expect(f.status).toBe("ok");
    if (f.status !== "ok") return;
    expect(f.data.partial).toBe(true);
    expect(f.data.places.map((p) => p.name)).toEqual(["p2"]);
    expect(f.data.typeStatus).toMatchObject({ cinema: "ok", escape_game: "empty", swimming: "empty", climbing_hall: "empty", karaoke: "error", indoor_play: "error" });
  });

  it("Overpass part fails and Geoapify finds nothing: ok + partial, never empty", async () => {
    geoByCategory({});
    h.runQuery.mockRejectedValue(new Error("504"));
    expect(await getActivityGroupFacts("indoor", dest("city"), ctx)).toMatchObject({ status: "ok", data: { places: [], partial: true } });
  });

  it("Geoapify fails: its types fall back to Overpass (union of just those lines), the rest runs separately", async () => {
    h.fetchPlaces.mockRejectedValue(new Error("quota"));
    h.runQuery.mockResolvedValue(emptyOverpass);
    const f = await getActivityGroupFacts("indoor", dest("city"), ctx);
    expect(h.runQuery).toHaveBeenCalledTimes(2);
    const q1 = h.runQuery.mock.calls[0][0] as string;
    expect(q1).toMatch(/escape_game/);
    expect(q1).not.toMatch(/karaoke_box/);
    expect(h.runQuery.mock.calls[1][0] as string).toMatch(/karaoke_box/);
    expect(f).toMatchObject({ status: "empty", data: { partial: false } });
  });

  it("Geoapify and its Overpass fallback fail, the other Overpass part works: partial, Geoapify types error", async () => {
    h.fetchPlaces.mockRejectedValue(new Error("quota"));
    h.runQuery
      .mockRejectedValueOnce(new Error("504"))
      .mockResolvedValue({ elements: [geoNode(3, { amenity: "karaoke_box" })], status: 200, latencyMs: 1, mirror: "m" });
    const f = await getActivityGroupFacts("indoor", dest("city"), ctx);
    expect(f).toMatchObject({ status: "ok", data: { partial: true, typeStatus: { escape_game: "error", swimming: "error", karaoke: "ok", indoor_play: "empty" } } });
  });

  it("every part fails: error", async () => {
    h.fetchPlaces.mockRejectedValue(new Error("quota"));
    h.runQuery.mockRejectedValue(new Error("504"));
    expect(await getActivityGroupFacts("indoor", dest("city"), ctx)).toEqual({ status: "error", source: "osm" });
  });

  it("cache only: the cached Overpass part is used, the uncached Geoapify part is skipped (partial)", async () => {
    h.store.set('overpass#"part":"osm"', { data: { items: [], truncated: false }, expired: false });
    const f = await getActivityGroupFacts("indoor", dest("city"), ctx, { budgetMs: 0 });
    expect(h.fetchPlaces).not.toHaveBeenCalled();
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(f).toMatchObject({ status: "ok", data: { partial: true, typeStatus: { escape_game: "skipped", karaoke: "empty" } } });
  });

  it("cache only with nothing cached: skipped", async () => {
    expect(await getActivityGroupFacts("indoor", dest("city"), ctx, { budgetMs: 0 })).toEqual({ status: "skipped", reason: "cache_only" });
  });

  it("a type whose Geoapify page was full is cut (not empty); the other Geoapify types are still empty", async () => {
    geoByCategory({}, { "entertainment.culture.theatre": { truncated: true } });
    h.runQuery.mockResolvedValue(emptyOverpass);
    const f = await getActivityGroupFacts("indoor", dest("city"), ctx);
    expect(f).toMatchObject({ status: "ok", data: { truncated: true, typeStatus: { theatre: "cut", cinema: "empty", karaoke: "empty" } } });
    expect(h.events.filter((e) => e.event === "places.truncated")).toHaveLength(1);
  });

  it("an Overpass answer at the cap cuts the Overpass-only types, not the Geoapify ones", async () => {
    geoByCategory({});
    h.runQuery.mockResolvedValue(cappedAnswer());
    const f = await getActivityGroupFacts("indoor", dest("city"), ctx);
    expect(f).toMatchObject({ status: "ok", data: { typeStatus: { cinema: "empty", karaoke: "cut", indoor_play: "cut" } } });
  });

  it("quota: the Geoapify part reports the credits of all its requests as units", async () => {
    geoByCategory({});
    h.runQuery.mockResolvedValue(emptyOverpass);
    await getActivityGroupFacts("indoor", dest("city"), ctx);
    expect(h.calls.find((c) => c.provider === "geoapify")?.units).toBe(6);
  });

  it("quota: a failure after earlier types succeeded carries their credits on the error", async () => {
    h.fetchPlaces
      .mockResolvedValueOnce({ elements: [], status: 200, latencyMs: 1, credits: 2, truncated: false })
      .mockResolvedValueOnce({ elements: [], status: 200, latencyMs: 1, credits: 1, truncated: false })
      .mockRejectedValueOnce(new Error("5xx"));
    h.runQuery.mockResolvedValue(emptyOverpass);
    await getActivityGroupFacts("indoor", dest("city"), ctx);
    expect(h.errors[0]).toMatchObject({ units: 3 });
  });

  it("going_out is unchanged: one Geoapify request with its three categories, no Overpass", async () => {
    h.fetchPlaces.mockResolvedValue(geoBar);
    const f = await getActivityGroupFacts("going_out", dest("city"), ctx);
    expect(h.fetchPlaces).toHaveBeenCalledTimes(1);
    expect(h.runQuery).not.toHaveBeenCalled();
    expect(f).toMatchObject({ status: "ok", data: { partial: false, typeStatus: { bar: "ok" } } });
  });

  it("every catalogue type of a group gets a status", async () => {
    geoByCategory({});
    h.runQuery.mockResolvedValue(emptyOverpass);
    const f = await getActivityGroupFacts("outdoor", dest("city"), ctx);
    if (f.status === "skipped" || f.status === "error") throw new Error("expected a result");
    expect(Object.keys(f.data.typeStatus).sort()).toEqual(["boat_rental", "canoe", "climbing", "footgolf", "karting", "minigolf", "playground", "rowing"]);
  });
});

describe("mergeGroupParts", () => {
  const fact = (status: "ok" | "empty", over: object = {}) =>
    ({ status, data: { places: [], truncated: false }, source: "osm", sourceUrl: "u", fetchedAt: "2026-11-06T00:00:00.000Z", stale: false, ...over }) as never;
  it("empty only when every part is complete and empty", () => {
    const parts = [{ types: ["cinema"], fact: fact("empty") }, { types: ["karaoke"], fact: fact("empty") }] as never;
    expect(mergeGroupParts("indoor", 15, parts).status).toBe("empty");
  });
  it("takes the oldest fetchedAt and any stale flag", () => {
    const parts = [
      { types: ["cinema"], fact: fact("empty", { fetchedAt: "2026-10-01T00:00:00.000Z" }) },
      { types: ["karaoke"], fact: fact("empty", { stale: true }) },
    ] as never;
    expect(mergeGroupParts("indoor", 15, parts)).toMatchObject({ fetchedAt: "2026-10-01T00:00:00.000Z", stale: true });
  });
  it("error + skipped is error; all skipped is skipped", () => {
    const sk = { status: "skipped", reason: "cache_only" };
    const er = { status: "error", source: "osm" };
    expect(mergeGroupParts("indoor", 15, [{ types: ["cinema"], fact: sk }, { types: ["karaoke"], fact: er }] as never).status).toBe("error");
    expect(mergeGroupParts("indoor", 15, [{ types: ["cinema"], fact: sk }, { types: ["karaoke"], fact: sk }] as never)).toEqual({ status: "skipped", reason: "cache_only" });
  });
  it("the Geoapify-served types are exactly the ones with a category in the catalogue", () => {
    expect(Object.entries(ACTIVITY_SOURCES).filter(([, v]) => v.geoapify).map(([k]) => k).sort()).toEqual(
      ["bar", "boat_rental", "bowling", "cinema", "climbing_hall", "escape_game", "minigolf", "playground", "swimming", "theatre"],
    );
  });
});
