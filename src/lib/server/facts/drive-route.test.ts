import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  cacheStore: new Map<string, unknown>(),
  cachedCalls: [] as Record<string, unknown>[],
  route: vi.fn(),
  count: 0 as number | null,
  countError: null as unknown,
}));
/** An in-memory api_cache: a hit never calls the fetcher; a miss stores the fetched value. */
vi.mock("../api-cache", async (orig) => {
  const m = await orig<typeof import("../api-cache")>();
  return {
    ...m,
    cached: async (o: { key: string; schema: { parse: (v: unknown) => unknown }; fetcher: () => Promise<{ data: unknown }> }) => {
      h.cachedCalls.push(o);
      if (h.cacheStore.has(o.key)) return { ok: true, data: h.cacheStore.get(o.key), fetchedAt: "f", stale: false, cache: "hit" };
      try {
        const r = await o.fetcher();
        const data = o.schema.parse(r.data);
        h.cacheStore.set(o.key, data);
        return { ok: true, data, fetchedAt: "f", stale: false, cache: "miss" };
      } catch (e) {
        return { ok: false, error: (e as Error).name === "QuotaGuardError" ? "quota_exhausted" : "provider_error" };
      }
    },
  };
});
vi.mock("../supabase/admin", () => ({
  createSupabaseAdminClient: () => {
    const q = { select: () => q, eq: () => q, neq: () => q, gte: async () => ({ count: h.count, error: h.countError }) };
    return { from: () => q };
  },
}));
vi.mock("@/lib/integrations/openrouteservice", async (orig) => {
  const m = await orig<typeof import("@/lib/integrations/openrouteservice")>();
  return { ...m, fetchDriveRoute: h.route };
});

import { driveRouteKey, DRIVE_ROUTE_TTL_SECONDS, getDriveRoute } from "./drive-route";
import { orsRequestsLeft } from "./ors-quota";

const frankfurt = { lat: 50.11094, lon: 8.68213 };
const munich = { geoId: 2867714, lat: 48.14, lon: 11.58 };
const ctx = { userId: "u1", locale: "de" as const, today: "2026-11-01" };

describe("getDriveRoute", () => {
  beforeEach(() => {
    h.cacheStore.clear();
    h.cachedCalls.length = 0;
    h.route.mockReset();
    h.count = 0;
    h.countError = null;
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "k");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("key per place pair: origin at 3 decimals + destination geoId, no owner in it", () => {
    expect(driveRouteKey(frankfurt, 2867714)).toBe("route:v1:geoId=2867714;lat=50.111;lon=8.682");
    expect(driveRouteKey({ lat: 50.1112, lon: 8.6818 }, 2867714)).toBe(driveRouteKey(frankfurt, 2867714)); // same town, same key
    expect(driveRouteKey(frankfurt, 1)).not.toBe(driveRouteKey(frankfurt, 2));
    expect(driveRouteKey(frankfurt, 2867714)).not.toContain("u1");
  });

  it("calls the cache with provider openrouteservice, endpoint route and 90 days", async () => {
    h.route.mockResolvedValue({ route: { road: true, min: 209, km: 392.3 }, status: 200, latencyMs: 3 });
    const r = await getDriveRoute(frankfurt, munich, ctx);
    expect(r).toMatchObject({ ok: true, data: { road: true, min: 209, km: 392.3 } });
    expect(h.cachedCalls[0]).toMatchObject({ provider: "openrouteservice", endpoint: "route", ttlSeconds: 90 * 86400 });
    expect(DRIVE_ROUTE_TTL_SECONDS).toBe(90 * 86400);
    expect(h.route).toHaveBeenCalledWith(frankfurt, munich);
  });

  it("T7: a second search from the same town and place is a cache hit, no ORS call; another user too", async () => {
    h.route.mockResolvedValue({ route: { road: true, min: 209, km: 392.3 }, status: 200, latencyMs: 3 });
    await getDriveRoute(frankfurt, munich, ctx);
    const again = await getDriveRoute({ lat: 50.1112, lon: 8.6818 }, munich, { ...ctx, userId: "u2" });
    expect(again).toMatchObject({ ok: true, cache: "hit" });
    expect(h.route).toHaveBeenCalledTimes(1);
  });

  it("'no road' is a cached result: an island is asked once", async () => {
    h.route.mockResolvedValue({ route: { road: false }, status: 404, latencyMs: 3 });
    const palma = { geoId: 2512989, lat: 39.57, lon: 2.65 };
    expect(await getDriveRoute(frankfurt, palma, ctx)).toMatchObject({ ok: true, data: { road: false } });
    expect(await getDriveRoute(frankfurt, palma, ctx)).toMatchObject({ ok: true, data: { road: false }, cache: "hit" });
    expect(h.route).toHaveBeenCalledTimes(1);
  });

  it("a failure is ok: false, never { road: false }, and is not cached", async () => {
    h.route.mockRejectedValue(Object.assign(new Error("x"), { name: "HttpError", status: 503 }));
    expect(await getDriveRoute(frankfurt, munich, ctx)).toEqual({ ok: false, error: "provider_error" });
    expect(h.cacheStore.size).toBe(0);
  });

  it("the daily cap is checked before the request (the cap is shared with plans); an unreadable count fails closed", async () => {
    h.count = 400;
    expect(await getDriveRoute(frankfurt, munich, ctx)).toEqual({ ok: false, error: "quota_exhausted" });
    h.count = null;
    h.countError = { code: "x" };
    expect(await getDriveRoute(frankfurt, munich, ctx)).toEqual({ ok: false, error: "quota_exhausted" });
    expect(h.route).not.toHaveBeenCalled();
  });

  it("no key: no cache access and no request", async () => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "");
    expect(await getDriveRoute(frankfurt, munich, ctx)).toEqual({ ok: false, error: "provider_error" });
    expect(h.cachedCalls).toHaveLength(0);
  });
});

describe("orsRequestsLeft", () => {
  beforeEach(() => {
    h.count = 0;
    h.countError = null;
  });
  it("cap (default 400) minus today's network requests, never below 0", async () => {
    h.count = 120;
    expect(await orsRequestsLeft()).toBe(280);
    h.count = 999;
    expect(await orsRequestsLeft()).toBe(0);
  });
  it("fails closed: an unreadable count is 0", async () => {
    h.count = null;
    h.countError = { code: "x" };
    expect(await orsRequestsLeft()).toBe(0);
  });
});
