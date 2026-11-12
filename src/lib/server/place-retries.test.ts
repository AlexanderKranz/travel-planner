import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const rpc = vi.fn();
const countResult = vi.fn();
// Minimal query builder for the Health counts: every chain step returns itself, awaiting yields countResult().
const countQuery = () => {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.gte = () => q;
  q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(countResult()).then(ok, ko);
  return q;
};
vi.mock("./supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ rpc: (...a: unknown[]) => rpc(...a), from: () => countQuery() }),
}));
vi.mock("./events", () => ({ logEvent: vi.fn() }));
vi.mock("./facts/activities", () => ({ getActivityGroupFacts: vi.fn(), getCafeFacts: vi.fn(), getRestaurantFacts: vi.fn() }));
vi.mock("./facts/places", () => ({ retryInterestLookup: vi.fn() }));

import type { RetrySpec } from "@/lib/places-retry";
import { enqueuePlaceRetries, getPlaceRetryStats, groupDone, JOB_GRACE_MS, MIN_JOB_START_MS, processJobs, RUN_BUDGET_MS, type JobRow } from "./place-retries";

const T0 = Date.parse("2026-11-06T12:00:00Z");
const spec: RetrySpec = { kind: "restaurants", dest: { lat: 49, lon: 12, kind: "city" } };
const row = (over: Partial<JobRow> = {}): JobRow => ({
  id: "j1",
  kind: "restaurants",
  params: spec,
  attempts: 0,
  created_at: new Date(T0 - 5 * 60_000).toISOString(),
  give_up_at: new Date(T0 + 25 * 60_000).toISOString(),
  ...over,
});

describe("enqueuePlaceRetries", () => {
  beforeEach(() => rpc.mockReset());
  it("sends the jobs through the enqueue function (dedupe happens in the database)", async () => {
    rpc.mockResolvedValue({ data: 1, error: null });
    const jobs = [{ kind: "restaurants" as const, cache_key: "restaurants:1", params: spec }];
    await enqueuePlaceRetries(jobs);
    expect(rpc).toHaveBeenCalledWith("place_retry_enqueue", { p_jobs: jobs });
  });
  it("does nothing for an empty list", async () => {
    await enqueuePlaceRetries([]);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("never throws, whatever the database does", async () => {
    rpc.mockRejectedValue(new Error("down"));
    await expect(enqueuePlaceRetries([{ kind: "cafes", cache_key: "k", params: spec }])).resolves.toBeUndefined();
    rpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    await expect(enqueuePlaceRetries([{ kind: "cafes", cache_key: "k", params: spec }])).resolves.toBeUndefined();
  });
});

describe("processJobs", () => {
  it("marks done on success and counts the attempt", async () => {
    const run = vi.fn().mockResolvedValue("done");
    const [r] = await processJobs([row()], run, { startedAt: T0, now: () => T0 });
    expect(r).toMatchObject({ result: "done", attempts: 1, ageMin: 5 });
    expect(run).toHaveBeenCalledWith(spec, expect.any(Number));
  });
  it("keeps a failed job queued while the window is open", async () => {
    const [r] = await processJobs([row({ attempts: 2 })], async () => "failed", { startedAt: T0, now: () => T0 });
    expect(r).toMatchObject({ result: "failed", attempts: 3, error: "lookup_failed" });
  });
  it("gives up without running when give_up_at has passed", async () => {
    const run = vi.fn();
    const [r] = await processJobs([row({ give_up_at: new Date(T0 - 1).toISOString() })], run, { startedAt: T0, now: () => T0 });
    expect(r.result).toBe("gave_up");
    expect(run).not.toHaveBeenCalled();
  });
  it("a failure that ends after the window is final", async () => {
    let t = T0;
    const [r] = await processJobs([row({ give_up_at: new Date(T0 + 1_000).toISOString() })], async () => ((t += 60_000), "failed"), { startedAt: T0, now: () => t });
    expect(r).toMatchObject({ result: "gave_up", attempts: 1 });
  });
  it("a thrown error counts as a failed attempt", async () => {
    const [r] = await processJobs([row()], async () => Promise.reject(new TypeError("x")), { startedAt: T0, now: () => T0 });
    expect(r).toMatchObject({ result: "failed", error: "TypeError" });
  });
  it("runs jobs one at a time and stops starting new ones when the run budget is nearly used", async () => {
    let t = T0;
    const order: string[] = [];
    const run = vi.fn(async (_s: RetrySpec, budget: number) => {
      order.push(`start@${Math.round((t - T0) / 1000)}`);
      expect(budget).toBeLessThanOrEqual(120_000);
      t += 100_000; // one slow Overpass query
      return "failed" as const;
    });
    const jobs = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" }), row({ id: "d" })];
    const res = await processJobs(jobs, run, { startedAt: T0, now: () => t });
    // 240 s budget: starts at 0 s and 100 s; at 200 s only 40 s are left (< 45 s), so the rest are skipped.
    expect(order).toEqual(["start@0", "start@100"]);
    expect(res.map((r) => r.result)).toEqual(["failed", "failed", "skipped", "skipped"]);
    expect(RUN_BUDGET_MS - 200_000).toBeLessThan(MIN_JOB_START_MS);
  });
  it("a job never gets more time than is left in the run", async () => {
    const run = vi.fn().mockResolvedValue("done");
    await processJobs([row()], run, { startedAt: T0, now: () => T0 + 150_000 });
    expect(run.mock.calls[0][1]).toBeLessThanOrEqual(90_000 - 5_000);
  });
  it("gives up on stored parameters that no longer parse", async () => {
    const run = vi.fn();
    const [r] = await processJobs([row({ params: { kind: "nope" } })], run, { startedAt: T0, now: () => T0 });
    expect(r).toMatchObject({ result: "gave_up", error: "bad_params" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("groupDone", () => {
  const fact = (status: string, typeStatus: Record<string, string>) => ({ status, data: { typeStatus, partial: true } }) as never;
  it("ok/empty with the wanted types answered is done, even if an unwished part failed", () => {
    expect(groupDone(fact("ok", { bowling: "ok", cinema: "error" }), ["bowling"])).toBe(true);
    expect(groupDone(fact("empty", { bowling: "empty" }), ["bowling"])).toBe(true);
  });
  it("a failed or skipped wanted type keeps the job alive", () => {
    expect(groupDone(fact("ok", { bowling: "error", cinema: "ok" }), ["bowling"])).toBe(false);
    expect(groupDone(fact("ok", { bowling: "skipped" }), ["bowling"])).toBe(false);
  });
  it("no wanted types (group-only wish): every type counts", () => {
    expect(groupDone(fact("ok", { bowling: "ok", cinema: "error" }), [])).toBe(false);
    expect(groupDone(fact("ok", { bowling: "ok", cinema: "cut" }), [])).toBe(true);
  });
  it("error and skipped lookups are never done", () => {
    expect(groupDone({ status: "error", source: "osm" } as never, ["bowling"])).toBe(false);
    expect(groupDone({ status: "skipped", reason: "cache_only" } as never, [])).toBe(false);
  });
});

describe("processJobs hard stop", () => {
  it("cuts off a lookup that ignores its budget", async () => {
    vi.useFakeTimers();
    try {
      const p = processJobs([row()], () => new Promise(() => {}), { startedAt: T0, now: () => T0 });
      await vi.advanceTimersByTimeAsync(120_000 + JOB_GRACE_MS + 1);
      const [r] = await p;
      expect(r).toMatchObject({ result: "failed", error: "job_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getPlaceRetryStats", () => {
  it("returns the three counts", async () => {
    countResult.mockReturnValue({ count: 2, error: null });
    await expect(getPlaceRetryStats()).resolves.toEqual({ queued: 2, done: 2, gaveUp: 2 });
  });
  it("throws on a query error, so the Health tile is hidden instead of showing 0", async () => {
    countResult.mockReturnValue({ count: null, error: { code: "42P01", message: "relation does not exist" } });
    await expect(getPlaceRetryStats()).rejects.toMatchObject({ code: "42P01" });
  });
});

describe("runLookup: city tour landmarks (reserved interest name)", () => {
  it("runs the landmark warm-up with the job's point and budget, not an interest lookup", async () => {
    const warm = vi.fn().mockResolvedValue("ok");
    vi.doMock("./tour/landmarks", () => ({ warmLandmarks: warm }));
    const { runLookup } = await import("./place-retries");
    const { retryInterestLookup } = await import("./facts/places");
    const ctx = { userId: null, locale: "de" as const, today: "2026-11-12" };
    const job = { kind: "interest" as const, interest: "landmarks", lat: 50.116, lon: 8.684, radiusKm: 8 };
    expect(await runLookup(job, 90_000, ctx)).toBe("done");
    expect(warm).toHaveBeenCalledWith(job, ctx, 90_000);
    expect(retryInterestLookup).not.toHaveBeenCalled();
    warm.mockResolvedValue("failed");
    expect(await runLookup(job, 90_000, ctx)).toBe("failed");
    vi.doUnmock("./tour/landmarks");
  });
});

describe("runLookup: forced Overpass for an interest", () => {
  it("passes `overpass` to the interest lookup", async () => {
    const { runLookup } = await import("./place-retries");
    const { retryInterestLookup } = await import("./facts/places");
    vi.mocked(retryInterestLookup).mockResolvedValue("ok");
    const ctx = { userId: null, locale: "de" as const, today: "2026-11-12" };
    const job = { kind: "interest" as const, interest: "general", lat: 41.389, lon: 2.159, radiusKm: 15, overpass: true as const };
    expect(await runLookup(job, 90_000, ctx)).toBe("done");
    expect(retryInterestLookup).toHaveBeenCalledWith("general", job, 15, ctx, 90_000, { overpass: true });
  });
});
