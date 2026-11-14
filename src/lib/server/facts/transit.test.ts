import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  calls: [] as Record<string, unknown>[],
  rpc: vi.fn(),
  plan: vi.fn(),
}));
vi.mock("../api-cache", async (orig) => {
  const m = await orig<typeof import("../api-cache")>();
  return {
    ...m,
    peekCache: async (o: { key: string }) => (h.store.has(o.key) ? { data: h.store.get(o.key), fetchedAt: "f0" } : undefined),
    cached: async (o: { key: string; schema: { parse: (v: unknown) => unknown }; fetcher: () => Promise<{ data: unknown }> }) => {
      h.calls.push(o);
      if (h.store.has(o.key)) return { ok: true, data: h.store.get(o.key), fetchedAt: "f0", stale: false, cache: "hit" };
      try {
        const data = o.schema.parse((await o.fetcher()).data);
        h.store.set(o.key, data);
        return { ok: true, data, fetchedAt: "f1", stale: false, cache: "miss" };
      } catch {
        return { ok: false, error: "provider_error" };
      }
    },
  };
});
vi.mock("../supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: h.rpc }) }));
vi.mock("@/lib/integrations/transitous", () => ({ fetchPlan: h.plan }));

import { getTransitLeg, transitDailyCap, transitKey } from "./transit";

const A = { lat: 48.20853, lon: 16.37319 };
const B = { lat: 48.18486, lon: 16.31224 };
const DEP = { utcMs: Date.UTC(2026, 10, 17, 9), iso: "2026-11-17T09:00:00.000Z" };
const ctx = { userId: "u1" };
const answer = { kind: "no_connection" };

beforeEach(() => {
  h.store.clear();
  h.calls.length = 0;
  h.rpc.mockReset();
  h.plan.mockReset().mockResolvedValue({ answer, status: 200, latencyMs: 80 });
  vi.useRealTimers();
});

describe("getTransitLeg", () => {
  it("reserves a slot, fetches, caches 7 days as transitous/plan and settles the slot", async () => {
    h.rpc.mockImplementation(async (fn: string) => (fn === "provider_reserve_slot" ? { data: { ok: true, id: "s1" }, error: null } : { data: null, error: null }));
    const r = await getTransitLeg(A, B, DEP, "Europe/Vienna", ctx);
    expect(r).toMatchObject({ kind: "no_connection", cache: "miss" });
    expect(h.calls[0]).toMatchObject({ provider: "transitous", endpoint: "plan", ttlSeconds: 7 * 86400, key: transitKey(A, B, DEP.iso) });
    const [fn, args] = h.rpc.mock.calls[0];
    expect(fn).toBe("provider_reserve_slot");
    expect(args).toMatchObject({ p_provider: "transitous", p_daily_cap: 500 });
    expect(args.p_cache_key).toMatch(/^[0-9a-f]{64}$/);
    expect(h.rpc).toHaveBeenLastCalledWith("provider_settle_slot", { p_id: "s1" });
    // A cache hit needs no slot.
    h.rpc.mockClear();
    expect(await getTransitLeg(A, B, DEP, "Europe/Vienna", ctx)).toMatchObject({ cache: "hit" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("cap reached or slot state unreadable → failed, no request (fail closed)", async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, reason: "cap" }, error: null });
    expect(await getTransitLeg(A, B, DEP, "Europe/Vienna", ctx)).toEqual({ kind: "failed" });
    h.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    expect(await getTransitLeg(A, B, DEP, "Europe/Vienna", ctx)).toEqual({ kind: "failed" });
    expect(h.plan).not.toHaveBeenCalled();
  });

  it("a request already in flight for the same leg is awaited through the cache", async () => {
    vi.useFakeTimers();
    h.rpc.mockResolvedValue({ data: { ok: false, reason: "in_flight" }, error: null });
    const p = getTransitLeg(A, B, DEP, "Europe/Vienna", ctx);
    await vi.advanceTimersByTimeAsync(1000);
    h.store.set(transitKey(A, B, DEP.iso), answer); // the other request's answer lands
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toMatchObject({ kind: "no_connection", cache: "hit" });
    expect(h.plan).not.toHaveBeenCalled();
  });

  it("provider errors → failed, not cached; the slot is still settled", async () => {
    h.rpc.mockImplementation(async (fn: string) => (fn === "provider_reserve_slot" ? { data: { ok: true, id: "s2" }, error: null } : { data: null, error: null }));
    h.plan.mockRejectedValue(Object.assign(new Error("503"), { status: 503 }));
    expect(await getTransitLeg(A, B, DEP, "Europe/Vienna", ctx)).toEqual({ kind: "failed" });
    expect(h.store.size).toBe(0);
    expect(h.rpc).toHaveBeenLastCalledWith("provider_settle_slot", { p_id: "s2" });
  });

  it("daily cap from TRANSITOUS_DAILY, default 500", () => {
    expect(transitDailyCap({})).toBe(500);
    expect(transitDailyCap({ TRANSITOUS_DAILY: "120" })).toBe(120);
    expect(transitDailyCap({ TRANSITOUS_DAILY: "x" })).toBe(500);
  });
});
