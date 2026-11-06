import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./supabase/admin", () => ({ createSupabaseAdminClient: () => ({}) }));

import golf from "./__fixtures__/plan-document-golf.json";
import { readFileSync } from "node:fs";
import { MAX_VERSIONS_KEPT } from "@/lib/domain/plan";
import { acquireLock, getVersionLight, hasBusyPlan, isBusy, LOCK_MS, pruneVersions, releaseLock, StoredInput } from "./plan-store";
import { planInputHash } from "@/lib/plan/hash";
import type { PlanInputStored } from "@/lib/plan/input";
import { storedFor } from "@/lib/plan/test-helpers";

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
  it("hasRestaurants follows the stored restaurants status (also skipped/error), false when absent", async () => {
    expect((await getVersionLight(client({ data: row(), error: null }).sb, "p", 3))?.hasRestaurants).toBe(false);
    for (const s of ["ok", "empty", "skipped", "error"]) {
      expect((await getVersionLight(client({ data: row({ restaurants_status: s }), error: null }).sb, "p", 3))?.hasRestaurants).toBe(true);
    }
  });
  it("selects only the restaurants status, not the block", async () => {
    const { sb, seen } = client({ data: row(), error: null });
    await getVersionLight(sb, "p", 3);
    expect(seen.select).toContain("restaurants_status:input->llm->restaurants->>s");
  });
  it("returns null for no row, an invalid plan or invalid pendingPlaces, and throws on a read error", async () => {
    expect(await getVersionLight(client({ data: null, error: null }).sb, "p", 3)).toBeNull();
    expect(await getVersionLight(client({ data: row({ plan: { nope: 1 } }), error: null }).sb, "p", 3)).toBeNull();
    expect(await getVersionLight(client({ data: row({ pending_places: [1] }), error: null }).sb, "p", 3)).toBeNull();
    await expect(getVersionLight(client({ data: null, error: { code: "x" } }).sb, "p", 3)).rejects.toThrow("version read failed");
  });
});

describe("hasBusyPlan (per-user in-flight guard, sharing spec 3.5)", () => {
  const client = (rows: unknown[]) => {
    const eqs: [string, unknown][] = [];
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (c: string, v: unknown) => (eqs.push([c, v]), q);
    q.gt = () => q;
    q.limit = async () => ({ data: rows, error: null });
    return { sb: { from: () => q } as never, eqs };
  };
  it("counts only locks the acting user took (busy_by), not a run someone else started on a shared plan", async () => {
    const { sb, eqs } = client([]);
    expect(await hasBusyPlan(sb, "U1")).toBe(false);
    expect(eqs).toContainEqual(["busy_by", "U1"]);
  });
  it("is true when the user has a live lock of their own", async () => {
    expect(await hasBusyPlan(client([{ id: "p" }]).sb, "U1")).toBe(true);
  });
});

describe("pruneVersions (through the definer function)", () => {
  it("calls prune_plan_versions instead of deleting, and only past the limit", async () => {
    const rpc = vi.fn(async () => ({ error: null }));
    const del = vi.fn();
    const sb = { rpc, from: () => ({ delete: del }) } as never;
    await pruneVersions(sb, "p1", MAX_VERSIONS_KEPT);
    expect(rpc).not.toHaveBeenCalled(); // nothing to prune yet
    await pruneVersions(sb, "p1", MAX_VERSIONS_KEPT + 1);
    expect(rpc).toHaveBeenCalledWith("prune_plan_versions", { p_plan_id: "p1" });
    expect(del).not.toHaveBeenCalled();
  });
  it("the SQL function keeps the same number of versions as MAX_VERSIONS_KEPT", () => {
    const sql = readFileSync(new URL("../../../supabase/migrations/20261110120035_sharing.sql", import.meta.url), "utf8");
    const m = /version_no <= v_latest - (\d+)/.exec(sql);
    expect(m && Number(m[1])).toBe(MAX_VERSIONS_KEPT);
  });
});

describe("stored input round trip (issue #142)", () => {
  const st = storedFor(3);
  const input: PlanInputStored = { ...st, index: { ...st.index, p9: { key: "way/9", place: { ...st.index.p1.place, category: "leisure=water_park" }, g: "outdoor" } } };
  it("keeps the index `g` of a bath when the input is reloaded for a patch; the hash is unchanged", () => {
    const parsed = StoredInput.parse(JSON.parse(JSON.stringify(input)));
    expect(parsed.index.p9.g).toBe("outdoor");
    expect(parsed).toEqual(JSON.parse(JSON.stringify(input)));
    expect(planInputHash(parsed.llm as PlanInputStored["llm"])).toBe(planInputHash(input.llm));
  });
  it("older rows without `g` still parse", () => {
    expect(StoredInput.safeParse(JSON.parse(JSON.stringify(st))).success).toBe(true);
  });
});
