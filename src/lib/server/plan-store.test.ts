import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./supabase/admin", () => ({ createSupabaseAdminClient: () => ({}) }));

import { acquireLock, isBusy, LOCK_MS, releaseLock } from "./plan-store";

describe("generation lock expiry (stale lock recovery)", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");
  it("a lock is busy until busy_until, then the trip is free again", () => {
    expect(isBusy({ busyUntil: new Date(now + 1000).toISOString() }, now)).toBe(true);
    expect(isBusy({ busyUntil: new Date(now - 1000).toISOString() }, now)).toBe(false);
    expect(isBusy({ busyUntil: null }, now)).toBe(false);
    expect(isBusy(null, now)).toBe(false);
  });
  it("acquireLock only takes a free or expired lock, and sets it for LOCK_MS", async () => {
    const calls: { update?: unknown; or?: string } = {};
    const sb = {
      from: () => ({
        update: (v: unknown) => {
          calls.update = v;
          return {
            eq: () => ({
              or: (f: string) => {
                calls.or = f;
                return { select: async () => ({ data: [{ id: "p" }], error: null }) };
              },
            }),
          };
        },
      }),
    };
    expect(await acquireLock(sb as never, "p", now)).toBe(new Date(now + LOCK_MS).toISOString());
    expect(calls.or).toBe(`busy_until.is.null,busy_until.lt.${new Date(now).toISOString()}`);
    expect(calls.update).toEqual({ busy_until: new Date(now + LOCK_MS).toISOString() });
  });
  it("a held lock is not taken", async () => {
    const sb = { from: () => ({ update: () => ({ eq: () => ({ or: () => ({ select: async () => ({ data: [], error: null }) }) }) }) }) };
    expect(await acquireLock(sb as never, "p", now)).toBeNull();
  });
});

describe("releaseLock", () => {
  it("frees only the exact busy_until this run set (never a later run's lock)", async () => {
    const calls: { update?: unknown; eq: [string, unknown][] } = { eq: [] };
    const q = {
      eq: (c: string, v: unknown) => {
        calls.eq.push([c, v]);
        return q;
      },
      then: (r: (v: unknown) => void) => r({ error: null }),
    };
    const sb = { from: () => ({ update: (v: unknown) => ((calls.update = v), q) }) };
    await releaseLock(sb as never, "p", "2026-10-31T12:05:00.000Z");
    expect(calls.update).toEqual({ busy_until: null });
    expect(calls.eq).toEqual([["id", "p"], ["busy_until", "2026-10-31T12:05:00.000Z"]]);
  });
  it("swallows errors", async () => {
    const sb = { from: () => { throw new Error("db"); } };
    await expect(releaseLock(sb as never, "p", "t")).resolves.toBeUndefined();
  });
});
