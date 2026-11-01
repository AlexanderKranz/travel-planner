import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  cached: vi.fn(),
  matrix: vi.fn(),
  count: 0 as number | null,
  countError: null as unknown,
}));
vi.mock("../api-cache", async (orig) => {
  const m = await orig<typeof import("../api-cache")>();
  return { ...m, cached: h.cached };
});
vi.mock("../supabase/admin", () => ({
  createSupabaseAdminClient: () => {
    const q = {
      select: () => q,
      eq: () => q,
      neq: () => q,
      gte: async () => ({ count: h.count, error: h.countError }),
    };
    return { from: () => q };
  },
}));
vi.mock("@/lib/integrations/openrouteservice", async (orig) => {
  const m = await orig<typeof import("@/lib/integrations/openrouteservice")>();
  return { ...m, fetchDriveMatrix: h.matrix };
});

import { driveCacheKey, getDriveTimes, orsDailyCap } from "./drive-times";

const origin = { lat: 36.51543, lon: -4.88583 };
const places = [
  { key: "way/2", lat: 36.6, lon: -4.6 },
  { key: "way/1", lat: 36.5, lon: -4.7 },
];
const ctx = { userId: "u1", locale: "de" as const, today: "2026-10-28" };

/** Runs the real fetcher passed to cached(), like a cache miss. */
const missThrough = () =>
  h.cached.mockImplementation(async (o: { fetcher: () => Promise<{ data: unknown }> }) => {
    try {
      const r = await o.fetcher();
      return { ok: true, data: r.data, fetchedAt: "2026-10-28T10:00:00.000Z", stale: false, cache: "miss" };
    } catch (e) {
      return { ok: false, error: (e as Error).name === "QuotaGuardError" ? "quota_exhausted" : "provider_error" };
    }
  });

describe("getDriveTimes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.count = 0;
    h.countError = null;
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "k");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("cache key: rounded origin, order-independent hash of places; provider openrouteservice, 90 d", async () => {
    expect(driveCacheKey(origin, places)).toBe(driveCacheKey({ lat: 36.5151, lon: -4.8862 }, [...places].reverse()));
    expect(driveCacheKey(origin, places)).not.toBe(driveCacheKey(origin, places.slice(0, 1)));
    expect(driveCacheKey(origin, places)).toMatch(/^matrix:v1:lat=36.515;lon=-4.886;p=[0-9a-f]{32}$/);
    h.cached.mockResolvedValue({ ok: true, data: {}, fetchedAt: "f", stale: false, cache: "hit" });
    await getDriveTimes(origin, places, ctx);
    expect(h.cached.mock.calls[0][0]).toMatchObject({ provider: "openrouteservice", endpoint: "matrix", ttlSeconds: 90 * 86400 });
  });

  it("one matrix call; unreachable places are omitted", async () => {
    missThrough();
    h.matrix.mockResolvedValue({ drives: [{ min: 30, km: 25 }, null], status: 200, latencyMs: 3 });
    const r = await getDriveTimes(origin, places, ctx);
    expect(h.matrix).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ byKey: { "way/2": { min: 30, km: 25 } }, fetchedAt: "2026-10-28T10:00:00.000Z" });
  });

  it("quota guard: no request at the daily cap (ORS_DAILY_REQUESTS, default 200) or when the count fails", async () => {
    missThrough();
    expect(orsDailyCap({})).toBe(200);
    expect(orsDailyCap({ ORS_DAILY_REQUESTS: "25" })).toBe(25);
    h.count = 200;
    expect(await getDriveTimes(origin, places, ctx)).toBeNull();
    h.count = null;
    h.countError = { code: "x" };
    expect(await getDriveTimes(origin, places, ctx)).toBeNull();
    expect(h.matrix).not.toHaveBeenCalled();
  });

  it("ORS failure or missing key → null (the plan generates without times)", async () => {
    missThrough();
    h.matrix.mockRejectedValue(Object.assign(new Error("x"), { status: 500 }));
    expect(await getDriveTimes(origin, places, ctx)).toBeNull();
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "");
    expect(await getDriveTimes(origin, places, ctx)).toBeNull();
    expect(await getDriveTimes(origin, [], ctx)).toBeNull();
    expect(h.cached).toHaveBeenCalledTimes(1);
  });
});
