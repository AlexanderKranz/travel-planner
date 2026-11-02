import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const logEvent = vi.fn();
vi.mock("../events", () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));
vi.mock("../settings", () => ({ getSetting: async () => ({ value: 30, source: "default", locked: false }) }));
const rpc = vi.fn();
const updates: { id: string; patch: Record<string, unknown> }[] = [];
vi.mock("../supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => ({ update: (patch: Record<string, unknown>) => ({ eq: async (_c: string, id: string) => (updates.push({ id, patch }), { error: null }) }) }),
  }),
}));
const createIssue = vi.fn();
const findIssueByRef = vi.fn();
let configured = true;
vi.mock("@/lib/integrations/github", () => ({
  githubConfig: () => (configured ? { token: "t", repo: "a/b" } : null),
  createIssue: (...a: unknown[]) => createIssue(...a),
  findIssueByRef: (...a: unknown[]) => findIssueByRef(...a),
}));

import { deliverFeedback } from "./deliver";

const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const URL = "https://github.com/a/b/issues/9";
const now = new Date("2026-11-02T10:00:00Z");
const row = (over: Record<string, unknown> = {}) => ({
  id: ID, ref: "FB-k3x9p2qa", kind: "bug", body: "Map broken", page_path: "/app/trips/:id", app_version: "local", client: null, screenshot_path: null, attempts: 1, ...over,
});
const claimed = (over?: Record<string, unknown>) => rpc.mockResolvedValue({ data: [row(over)], error: null });
const last = () => updates[updates.length - 1].patch;

beforeEach(() => {
  configured = true;
  rpc.mockReset();
  createIssue.mockReset();
  findIssueByRef.mockReset();
  logEvent.mockReset();
  updates.length = 0;
});

describe("deliverFeedback", () => {
  it("201: marks created, sets the issue, empties the body, clears the lease", async () => {
    claimed();
    createIssue.mockResolvedValue({ kind: "ok", value: { number: 9, url: URL } });
    const r = await deliverFeedback(ID, { userId: "u1", now });
    expect(r).toEqual({ outcome: "created", stop: false });
    expect(rpc).toHaveBeenCalledWith("feedback_claim", { p_id: ID, p_ceiling: 30 });
    expect(last()).toMatchObject({ status: "created", issue_number: 9, issue_url: URL, issue_created_at: now.toISOString(), body: null, lease_until: null });
    const sent = createIssue.mock.calls[0][0];
    expect(sent).toMatchObject({ kind: "bug", title: "[FB-k3x9p2qa] Bug: Map broken" });
    expect(sent.body).toContain("Map broken");
    expect(findIssueByRef).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "feedback.issue_created", props: { issue_number: 9, linked: false } }));
  });

  it("without a token nothing is claimed and the row stays pending", async () => {
    configured = false;
    expect(await deliverFeedback(ID)).toEqual({ outcome: "no_token", stop: false });
    expect(rpc).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("the lease prevents a double create: a row that cannot be claimed is skipped", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect(await deliverFeedback(ID)).toEqual({ outcome: "not_claimed", stop: false });
    expect(createIssue).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "feedback.deferred" }));
  });

  it("a claim error is not an attempt", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "x" } });
    expect((await deliverFeedback(ID)).outcome).toBe("not_claimed");
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("attempts > 1: an existing issue is found by its reference and linked, no create", async () => {
    claimed({ attempts: 2 });
    findIssueByRef.mockResolvedValue({ kind: "ok", value: { number: 9, url: URL } });
    expect(await deliverFeedback(ID, { now })).toEqual({ outcome: "linked", stop: false });
    expect(findIssueByRef).toHaveBeenCalledWith("FB-k3x9p2qa", expect.anything());
    expect(createIssue).not.toHaveBeenCalled();
    expect(last()).toMatchObject({ status: "created", issue_number: 9, body: null, lease_until: null });
  });

  it("attempts > 1 with no existing issue creates one", async () => {
    claimed({ attempts: 3 });
    findIssueByRef.mockResolvedValue({ kind: "ok", value: null });
    createIssue.mockResolvedValue({ kind: "ok", value: { number: 9, url: URL } });
    expect((await deliverFeedback(ID, { now })).outcome).toBe("created");
  });

  it("403/429 with a reset: stop, next_attempt_at = reset, attempt given back, lease cleared", async () => {
    claimed({ attempts: 2 });
    findIssueByRef.mockResolvedValue({ kind: "ok", value: null });
    const retryAt = new Date("2026-11-02T11:30:00Z");
    createIssue.mockResolvedValue({ kind: "rate_limited", retryAt });
    expect(await deliverFeedback(ID, { now })).toEqual({ outcome: "rate_limited", stop: true });
    expect(last()).toMatchObject({ next_attempt_at: retryAt.toISOString(), lease_until: null, attempts: 1, last_error: "rate_limited" });
    expect(last()).not.toHaveProperty("status");
  });

  it("401/404: stop, error event, row stays pending, lease cleared", async () => {
    claimed();
    createIssue.mockResolvedValue({ kind: "auth" });
    expect(await deliverFeedback(ID, { now })).toEqual({ outcome: "auth_failed", stop: true });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "feedback.github_auth_failed", level: "error" }));
    expect(last()).toMatchObject({ lease_until: null, attempts: 0 });
    expect(last()).not.toHaveProperty("status");
  });

  it("422: failed for good with the class 'validation'", async () => {
    claimed();
    createIssue.mockResolvedValue({ kind: "validation" });
    expect(await deliverFeedback(ID, { now })).toEqual({ outcome: "failed", stop: false });
    expect(last()).toMatchObject({ status: "failed", last_error: "validation", lease_until: null });
  });

  it("5xx and network errors: retry in one hour, lease cleared", async () => {
    for (const status of [503, null]) {
      updates.length = 0;
      claimed({ attempts: 4 });
      findIssueByRef.mockResolvedValue({ kind: "ok", value: null });
      createIssue.mockResolvedValue({ kind: "server", status });
      expect(await deliverFeedback(ID, { now })).toEqual({ outcome: "backoff", stop: false });
      expect(last()).toMatchObject({ next_attempt_at: "2026-11-02T11:00:00.000Z", lease_until: null, last_error: status === null ? "network" : "server_error" });
      expect(last()).not.toHaveProperty("status");
    }
  });

  it("the 8th failed attempt marks the report failed", async () => {
    claimed({ attempts: 8 });
    findIssueByRef.mockResolvedValue({ kind: "ok", value: null });
    createIssue.mockResolvedValue({ kind: "server", status: 500 });
    expect(await deliverFeedback(ID, { now })).toEqual({ outcome: "failed", stop: false });
    expect(last()).toMatchObject({ status: "failed", lease_until: null });
  });

  it("a failing duplicate search is treated like any other failure (nothing is created)", async () => {
    claimed({ attempts: 2 });
    findIssueByRef.mockResolvedValue({ kind: "server", status: 502 });
    expect((await deliverFeedback(ID, { now })).outcome).toBe("backoff");
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("a bad row counts the attempt: back-off first, failed at the 8th", async () => {
    rpc.mockResolvedValue({ data: [{ id: ID, attempts: 3 }], error: null });
    expect((await deliverFeedback(ID, { now })).outcome).toBe("backoff");
    expect(last()).toMatchObject({ last_error: "bad_row", lease_until: null, next_attempt_at: "2026-11-02T11:00:00.000Z" });
    rpc.mockResolvedValue({ data: [{ id: ID, attempts: 8 }], error: null });
    expect((await deliverFeedback(ID, { now })).outcome).toBe("failed");
    expect(last()).toMatchObject({ status: "failed" });
  });

  it("never logs the report text", async () => {
    claimed({ body: "SECRET-TEXT" });
    createIssue.mockResolvedValue({ kind: "ok", value: { number: 9, url: URL } });
    await deliverFeedback(ID, { now });
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("SECRET-TEXT");
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("FB-k3x9p2qa");
  });
});
