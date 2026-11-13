import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
type Call = { method: string; args: unknown[] };
const h = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  /** Rows per bucket, looked up by the endpoint list of the query. */
  counts: { matrix: 0, directions: 0 } as Record<string, number | null>,
  error: null as unknown,
  queries: [] as Call[][],
}));
vi.mock("../settings", () => ({ getEffectiveEnv: async () => h.env }));
vi.mock("../supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) => {
      const calls: Call[] = [{ method: "from", args: [table] }];
      h.queries.push(calls);
      const q: Record<string, (...args: unknown[]) => unknown> = {};
      for (const m of ["select", "eq", "in", "neq", "or"]) {
        q[m] = (...args: unknown[]) => {
          calls.push({ method: m, args });
          return q;
        };
      }
      q.gte = async (...args: unknown[]) => {
        calls.push({ method: "gte", args });
        const endpoints = calls.find((c) => c.method === "in")?.args[1] as string[];
        const bucket = endpoints.includes("matrix") ? "matrix" : "directions";
        return { count: h.counts[bucket], error: h.error };
      };
      return q;
    },
  }),
}));

import {
  ORS_BUCKET_ENDPOINTS,
  ORS_PLAN_RESERVE,
  assertOrsQuota,
  orsCaps,
  orsLeft,
  orsRequestsLeft,
  orsTourGate,
  orsUsage24h,
  tourGateOk,
} from "./ors-quota";

beforeEach(() => {
  h.env = {};
  h.counts = { matrix: 0, directions: 0 };
  h.error = null;
  h.queries.length = 0;
});

describe("ORS buckets", () => {
  it("caps: matrix 450 and Directions 1800 by default, from ORS_MATRIX_DAILY / ORS_DIRECTIONS_DAILY", () => {
    expect(orsCaps({})).toEqual({ matrix: 450, directions: 1800 });
    expect(orsCaps({ ORS_MATRIX_DAILY: "100", ORS_DIRECTIONS_DAILY: "0" })).toEqual({ matrix: 100, directions: 0 });
    expect(orsCaps({ ORS_MATRIX_DAILY: "x", ORS_DIRECTIONS_DAILY: "-1" })).toEqual({ matrix: 450, directions: 1800 });
    // The retired shared cap has no effect any more.
    expect(orsCaps({ ORS_DAILY_REQUESTS: "200" })).toEqual({ matrix: 450, directions: 1800 });
  });

  it("endpoints: plans + tour orders in matrix, drive searches + tour legs in Directions", () => {
    expect(ORS_BUCKET_ENDPOINTS).toEqual({ matrix: ["matrix", "tour_matrix"], directions: ["route", "tour_route", "tour_steps"] });
  });

  it("counts each bucket over the last 24 h (not since Berlin midnight), network calls only, guard refusals excluded", async () => {
    h.counts = { matrix: 7, directions: 31 };
    const now = new Date("2026-11-12T00:30:00Z"); // 01:30 in Berlin: a Berlin-day count would start 1.5 h ago
    expect(await orsUsage24h(now)).toEqual({ matrix: 7, directions: 31 });
    expect(h.queries).toHaveLength(2);
    for (const calls of h.queries) {
      const args = (m: string) => calls.filter((c) => c.method === m).map((c) => c.args);
      expect(args("from")).toEqual([["api_calls"]]);
      expect(args("eq")).toEqual([["provider", "openrouteservice"]]);
      expect(args("neq")).toEqual([["cache", "hit"]]);
      expect(args("or")).toEqual([["error_code.is.null,error_code.neq.quota_guard"]]);
      expect(args("gte")).toEqual([["created_at", "2026-11-11T00:30:00.000Z"]]);
    }
    const inArgs = h.queries.map((calls) => calls.find((c) => c.method === "in")!.args);
    expect(inArgs).toEqual([
      ["endpoint", ["matrix", "tour_matrix"]],
      ["endpoint", ["route", "tour_route", "tour_steps"]],
    ]);
  });

  it("left per bucket, never below 0; an unreadable count fails closed with 0 in both", async () => {
    h.env = { ORS_MATRIX_DAILY: "100", ORS_DIRECTIONS_DAILY: "50" };
    h.counts = { matrix: 30, directions: 80 };
    expect(await orsLeft()).toEqual({ matrix: 70, directions: 0 });
    expect(await orsRequestsLeft("matrix")).toBe(70);
    h.error = { code: "x" };
    expect(await orsLeft()).toEqual({ matrix: 0, directions: 0 });
  });

  it("assertOrsQuota refuses only the full bucket", async () => {
    h.env = { ORS_MATRIX_DAILY: "10", ORS_DIRECTIONS_DAILY: "10" };
    h.counts = { matrix: 10, directions: 9 };
    await expect(assertOrsQuota("matrix")).rejects.toMatchObject({ name: "QuotaGuardError" });
    await expect(assertOrsQuota("directions")).resolves.toBeUndefined();
    h.error = { code: "x" };
    await expect(assertOrsQuota("directions")).rejects.toMatchObject({ name: "QuotaGuardError" });
  });
});

describe("tour gate", () => {
  it("needs 1 matrix request above the plan reserve and one Directions request per run", () => {
    expect(ORS_PLAN_RESERVE).toBe(50);
    expect(tourGateOk({ matrix: 51, directions: 2 }, 2)).toBe(true);
    expect(tourGateOk({ matrix: 50, directions: 2 }, 2)).toBe(false); // would eat into the plans' reserve
    expect(tourGateOk({ matrix: 51, directions: 1 }, 2)).toBe(false);
    // "Keep my order": no matrix call, so the matrix bucket does not matter.
    expect(tourGateOk({ matrix: 0, directions: 1 }, 1, false)).toBe(true);
  });

  it("reads both buckets; an unreadable count closes the gate", async () => {
    h.counts = { matrix: 450 - 51, directions: 1800 - 3 };
    expect(await orsTourGate(3)).toBe(true);
    expect(await orsTourGate(4)).toBe(false);
    h.counts = { matrix: 450, directions: 0 };
    expect(await orsTourGate(1)).toBe(false);
    expect(await orsTourGate(1, { needsMatrix: false })).toBe(true);
    h.error = { code: "x" };
    expect(await orsTourGate(1, { needsMatrix: false })).toBe(false);
  });
});
