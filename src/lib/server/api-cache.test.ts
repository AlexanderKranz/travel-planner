import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

type Row = { payload: unknown; fetched_at: string; expires_at: string } | null;
const state = {
  row: null as Row,
  readError: null as { code: string } | null,
  upserts: [] as Record<string, unknown>[],
  calls: [] as Record<string, unknown>[],
};

vi.mock("./supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) => {
      if (table === "api_cache") {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: async () => ({ data: state.row, error: state.readError }),
          upsert: async (row: Record<string, unknown>) => {
            state.upserts.push(row);
            return { error: null };
          },
        };
        return chain;
      }
      return {
        insert: async (rows: Record<string, unknown>[]) => {
          state.calls.push(...rows);
          return { error: null };
        },
      };
    },
  }),
}));

import { cacheKey, cached } from "./api-cache";

const schema = z.object({ n: z.number() });
const ctx = { userId: "u1" };
const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();
const run = (
  fetcher: () => Promise<{ data: { n: number }; status: number; latencyMs: number; units?: number }>,
) => cached({ provider: "overpass", endpoint: "interpreter", key: "secret-key", ttlSeconds: 60, schema, fetcher, ctx });

beforeEach(() => {
  state.row = null;
  state.readError = null;
  state.upserts = [];
  state.calls = [];
});

describe("cacheKey", () => {
  it("sorts params and normalizes strings", () => {
    expect(cacheKey("search", 1, { q: "  Zürich   Altstadt ", lang: "DE" })).toBe(
      "search:v1:lang=de;q=zürich altstadt",
    );
    expect(cacheKey("search", 1, { b: 1, a: 2 })).toBe(cacheKey("search", 1, { a: 2, b: 1 }));
  });
  it("uses NFC so composed and decomposed accents match", () => {
    expect(cacheKey("s", 1, { q: "é" })).toBe(cacheKey("s", 1, { q: "é" }));
  });
});

describe("cached", () => {
  it("hit: fresh row, no fetch, one api_calls row", async () => {
    state.row = { payload: { v: { n: 1 } }, fetched_at: "2026-01-01T00:00:00Z", expires_at: future() };
    const fetcher = vi.fn();
    const res = await run(fetcher);
    expect(res).toMatchObject({ ok: true, data: { n: 1 }, stale: false, cache: "hit" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toMatchObject({ cache: "hit", ok: true, provider: "overpass", user_id: "u1" });
  });

  it("miss: fetches, upserts with ttl, logs status/latency/units", async () => {
    const res = await run(async () => ({ data: { n: 2 }, status: 200, latencyMs: 42, units: 105 }));
    expect(res).toMatchObject({ ok: true, data: { n: 2 }, cache: "miss", stale: false });
    expect(state.upserts).toHaveLength(1);
    const up = state.upserts[0] as { fetched_at: string; expires_at: string };
    expect(Date.parse(up.expires_at) - Date.parse(up.fetched_at)).toBe(60_000);
    expect(state.calls).toEqual([
      expect.objectContaining({ cache: "miss", ok: true, status: 200, latency_ms: 42, units: 105 }),
    ]);
  });

  it("expired row + fetch ok: refreshes", async () => {
    state.row = { payload: { v: { n: 1 } }, fetched_at: "2026-01-01T00:00:00Z", expires_at: past() };
    const res = await run(async () => ({ data: { n: 3 }, status: 200, latencyMs: 1 }));
    expect(res).toMatchObject({ ok: true, data: { n: 3 }, cache: "miss" });
  });

  it("stale-on-error: serves the expired row", async () => {
    state.row = { payload: { v: { n: 1 } }, fetched_at: "2026-01-01T00:00:00Z", expires_at: past() };
    const res = await run(async () => {
      throw Object.assign(new Error("boom"), { status: 429 });
    });
    expect(res).toMatchObject({
      ok: true,
      data: { n: 1 },
      stale: true,
      cache: "stale",
      fetchedAt: "2026-01-01T00:00:00Z",
    });
    expect(state.upserts).toHaveLength(0);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toMatchObject({ cache: "stale", ok: false, status: 429, error_code: "http_429" });
  });

  it("error without a cached row: ok false, nothing cached", async () => {
    const res = await run(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    expect(res).toEqual({ ok: false, error: "timeout" });
    expect(state.upserts).toHaveLength(0);
    expect(state.calls).toEqual([expect.objectContaining({ ok: false, error_code: "timeout" })]);
  });

  it("network errors map to provider_error", async () => {
    const res = await run(async () => {
      throw new Error("ECONNRESET");
    });
    expect(res).toEqual({ ok: false, error: "provider_error" });
    expect(state.calls[0]).toMatchObject({ error_code: "network" });
  });

  it("schema mismatch on the cached payload counts as a miss", async () => {
    state.row = { payload: { v: { n: "x" } }, fetched_at: "2026-01-01T00:00:00Z", expires_at: future() };
    const fetcher = vi.fn(async () => ({ data: { n: 5 }, status: 200, latencyMs: 1 }));
    const res = await run(fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ ok: true, data: { n: 5 }, cache: "miss" });
  });

  it("invalid fetched data: invalid_response, not cached", async () => {
    const res = await run(async () => ({ data: { n: "bad" } as never, status: 200, latencyMs: 1 }));
    expect(res).toEqual({ ok: false, error: "invalid_response" });
    expect(state.upserts).toHaveLength(0);
    expect(state.calls[0]).toMatchObject({ error_code: "zod" });
  });

  it("a failing cache read degrades to a miss", async () => {
    state.readError = { code: "XX000" };
    const res = await run(async () => ({ data: { n: 7 }, status: 200, latencyMs: 1 }));
    expect(res).toMatchObject({ ok: true, cache: "miss" });
  });

  it("api_calls rows never contain the cache key", async () => {
    await run(async () => ({ data: { n: 1 }, status: 200, latencyMs: 1 }));
    expect(JSON.stringify(state.calls)).not.toContain("secret-key");
    expect(Object.keys(state.calls[0])).not.toContain("cache_key");
  });

  it("QuotaGuardError maps to quota_exhausted and serves stale data when present", async () => {
    const guard = () => {
      throw Object.assign(new Error("cap"), { name: "QuotaGuardError" });
    };
    expect(await run(async () => guard())).toEqual({ ok: false, error: "quota_exhausted" });
    expect(state.calls[0]).toMatchObject({ ok: false, error_code: "quota_guard" });
    state.row = { payload: { v: { n: 3 } }, fetched_at: "2026-01-01T00:00:00Z", expires_at: past() };
    expect(await run(async () => guard())).toMatchObject({ ok: true, stale: true, data: { n: 3 } });
  });

  it("failed requests log the units and quota the error carries", async () => {
    const res = await run(async () => {
      throw Object.assign(new Error("HTTP 400"), { status: 400, units: 2, quotaRemaining: 311 });
    });
    expect(res).toEqual({ ok: false, error: "provider_error" });
    expect(state.calls[0]).toMatchObject({ error_code: "http_400", units: 2, quota_remaining: 311 });
  });
});
