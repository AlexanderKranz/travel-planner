import { beforeEach, describe, expect, it, vi } from "vitest";
import { chain, type Call } from "./test-support";

vi.mock("server-only", () => ({}));
const logEvent = vi.fn();
vi.mock("../events", () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));
let ceiling = 30;
vi.mock("../settings", () => ({ getSetting: async () => ({ value: ceiling, source: "default", locked: false }) }));
const deliver = vi.fn();
vi.mock("./deliver", () => ({ deliverFeedback: (...a: unknown[]) => deliver(...a) }));
const removePaths = vi.fn();
vi.mock("./storage", () => ({ removeScreenshotPaths: (...a: unknown[]) => removePaths(...a) }));
let configured = true;
vi.mock("@/lib/integrations/github", () => ({ githubConfig: () => (configured ? { token: "t", repo: "a/b" } : null) }));

type Handler = (calls: Call[]) => unknown;
const handlers: Handler[] = [];
const queries: Call[][] = [];
vi.mock("../supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: () => {
      const h = handlers.shift() ?? (() => ({ data: [], error: null, count: 0 }));
      const c = chain((calls) => h(calls));
      queries.push(c.calls);
      return c.builder;
    },
  }),
}));

import { deliverDueFeedback, runFeedbackCron, runFeedbackRetention } from "./cron";

const now = new Date("2026-11-02T20:30:00Z");
const counts = (created: number, leased: number): Handler[] => [() => ({ count: created, error: null }), () => ({ count: leased, error: null })];
const limitOf = (calls: Call[]) => calls.find((c) => c.method === "limit")?.args[0];

beforeEach(() => {
  ceiling = 30;
  configured = true;
  handlers.length = 0;
  queries.length = 0;
  deliver.mockReset();
  deliver.mockResolvedValue({ outcome: "created", stop: false });
  removePaths.mockReset();
  removePaths.mockResolvedValue(true);
  logEvent.mockReset();
});

describe("deliverDueFeedback", () => {
  it("takes at most 10 rows, oldest first, only due and unleased", async () => {
    handlers.push(...counts(0, 0), () => ({ data: Array.from({ length: 10 }, (_, i) => ({ id: `id${i}` })), error: null }));
    const r = await deliverDueFeedback(now);
    expect(r).toEqual({ attempted: 10, delivered: 10, stopped: false });
    const due = queries[2];
    expect(limitOf(due)).toBe(10);
    expect(due.find((c) => c.method === "order")?.args).toEqual(["created_at", { ascending: true }]);
    expect(due.find((c) => c.method === "or")?.args[0]).toContain("lease_until.is.null");
    expect(deliver).toHaveBeenCalledWith("id0", { userId: null, now });
  });
  it("is limited by the ceiling left today (created + live leases)", async () => {
    ceiling = 30;
    handlers.push(...counts(25, 2), () => ({ data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null }));
    await deliverDueFeedback(now);
    expect(limitOf(queries[2])).toBe(3);
  });
  it("does nothing at the ceiling or when paused (0)", async () => {
    handlers.push(...counts(30, 0));
    expect(await deliverDueFeedback(now)).toEqual({ attempted: 0, delivered: 0, stopped: false });
    ceiling = 0;
    handlers.push(...counts(0, 0));
    await deliverDueFeedback(now);
    expect(deliver).not.toHaveBeenCalled();
  });
  it("does nothing without a token", async () => {
    configured = false;
    expect(await deliverDueFeedback(now)).toEqual({ attempted: 0, delivered: 0, stopped: false });
    expect(queries).toHaveLength(0);
  });
  it("stops the run on a rate-limit or auth answer", async () => {
    handlers.push(...counts(0, 0), () => ({ data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null }));
    deliver.mockResolvedValueOnce({ outcome: "created", stop: false }).mockResolvedValueOnce({ outcome: "auth_failed", stop: true });
    const r = await deliverDueFeedback(now);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ attempted: 2, delivered: 1, stopped: true });
  });
});

describe("runFeedbackRetention", () => {
  it("purges screenshots older than 90 days and clears the path", async () => {
    handlers.push(
      () => ({ data: [{ id: "a", screenshot_path: "u/a.webp" }, { id: "b", screenshot_path: "u/b.png" }], error: null }),
      () => ({ error: null }),
      () => ({ data: [], error: null }),
      () => ({ data: [], error: null }),
    );
    const r = await runFeedbackRetention(now);
    expect(removePaths).toHaveBeenCalledWith(["u/a.webp", "u/b.png"]);
    expect(queries[0].find((c) => c.method === "lt")?.args).toEqual(["created_at", "2026-08-04T20:30:00.000Z"]);
    expect(queries[1].find((c) => c.method === "update")?.args).toEqual([{ screenshot_path: null }]);
    expect(r.screenshotsPurged).toBe(2);
  });
  it("keeps the path when Storage removal fails", async () => {
    removePaths.mockResolvedValue(false);
    handlers.push(() => ({ data: [{ id: "a", screenshot_path: "u/a.webp" }], error: null }));
    const r = await runFeedbackRetention(now);
    expect(r.screenshotsPurged).toBe(0);
    expect(queries.some((q) => q.some((c) => c.method === "update"))).toBe(false);
  });
  it("deletes created rows after 180 days and pending/failed after 365, never rows with a stored screenshot", async () => {
    handlers.push(
      () => ({ data: [], error: null }),
      () => ({ data: [{ id: "x" }, { id: "y" }], error: null }),
      () => ({ data: [{ id: "z" }], error: null }),
    );
    const r = await runFeedbackRetention(now);
    const [created, open] = [queries[1], queries[2]];
    expect(created.find((c) => c.method === "in")?.args).toEqual(["status", ["created"]]);
    expect(created.find((c) => c.method === "lt")?.args).toEqual(["created_at", "2026-05-06T20:30:00.000Z"]);
    expect(open.find((c) => c.method === "in")?.args).toEqual(["status", ["pending", "failed"]]);
    expect(open.find((c) => c.method === "lt")?.args).toEqual(["created_at", "2025-11-02T20:30:00.000Z"]);
    for (const q of [created, open]) expect(q.find((c) => c.method === "is")?.args).toEqual(["screenshot_path", null]);
    expect(r.rowsDeleted).toBe(3);
  });
});

describe("runFeedbackCron", () => {
  it("a delivery error does not stop the retention and nothing throws", async () => {
    handlers.push(() => ({ error: { code: "x" }, count: null }), () => ({ error: { code: "x" }, count: null }));
    handlers.push(() => ({ data: [], error: null }), () => ({ data: [], error: null }), () => ({ data: [], error: null }));
    const r = await runFeedbackCron(now);
    expect(r.delivered).toBe(0);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "cron.feedback_delivery_failed", level: "error" }));
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "cron.feedback" }));
  });
});
