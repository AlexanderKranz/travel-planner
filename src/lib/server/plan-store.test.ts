import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./supabase/admin", () => ({ createSupabaseAdminClient: () => ({}) }));

import golf from "./__fixtures__/plan-document-golf.json";
import { acquireLock, getVersionLight, isBusy, LOCK_MS, releaseLock } from "./plan-store";

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

describe("getVersionLight", () => {
  const plan = (golf as unknown as { plan: unknown }).plan;
  const row = (extra: Record<string, unknown> = {}) => ({
    version_no: 3, kind: "generated", created_at: "2026-10-01T00:00:00Z", feedback: null, restored_from: null,
    changed_days: null, model: "m", plan, pending_places: null, ...extra,
  });
  const client = (result: { data: unknown; error: unknown }) => {
    const seen: { select?: string } = {};
    const q = { eq: () => q, maybeSingle: async () => result, select: (c: string) => ((seen.select = c), q) };
    return { sb: { from: () => q } as never, seen };
  };

  it("never selects the whole input, only the pendingPlaces field", async () => {
    const { sb, seen } = client({ data: row(), error: null });
    await getVersionLight(sb, "p", 3);
    expect(seen.select).toContain("pending_places:input->pendingPlaces");
    expect(seen.select?.split(", ")).not.toContain("input");
  });
  it("maps meta and plan, and a missing pendingPlaces to an empty list", async () => {
    const { sb } = client({ data: row(), error: null });
    const v = await getVersionLight(sb, "p", 3);
    expect(v?.meta.versionNo).toBe(3);
    expect(v?.pendingPlaces).toEqual([]);
    expect(v?.plan.days.length).toBeGreaterThan(0);
  });
  it("passes pendingPlaces through", async () => {
    const { sb } = client({ data: row({ pending_places: ["golf"] }), error: null });
    expect((await getVersionLight(sb, "p", 3))?.pendingPlaces).toEqual(["golf"]);
  });
  it("returns null for no row, an invalid plan or invalid pendingPlaces, and throws on a read error", async () => {
    expect(await getVersionLight(client({ data: null, error: null }).sb, "p", 3)).toBeNull();
    expect(await getVersionLight(client({ data: row({ plan: { nope: 1 } }), error: null }).sb, "p", 3)).toBeNull();
    expect(await getVersionLight(client({ data: row({ pending_places: [1] }), error: null }).sb, "p", 3)).toBeNull();
    await expect(getVersionLight(client({ data: null, error: { code: "x" } }).sb, "p", 3)).rejects.toThrow("version read failed");
  });
});
