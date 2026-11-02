import { beforeEach, describe, expect, it, vi } from "vitest";
import { chain } from "../feedback/test-support";

vi.mock("server-only", () => ({}));
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
const session = vi.fn();
vi.mock("../session", () => ({ getUserSession: () => session() }));
const logEvent = vi.fn();
vi.mock("../events", () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));
const adminCreated = vi.fn();
let feedbackRow: unknown = null;
const counts = { perDay: 1, pending: 4, failed: 2 };
const getUserById = vi.fn();
const createSignedUrl = vi.fn();
vi.mock("../supabase/admin", () => ({
  createSupabaseAdminClient: () => {
    adminCreated();
    return {
      auth: { admin: { getUserById: (...a: unknown[]) => getUserById(...a) } },
      storage: { from: () => ({ createSignedUrl: (...a: unknown[]) => createSignedUrl(...a) }) },
      from: () =>
        chain((calls) => {
          const eq = calls.find((c) => c.method === "eq");
          if (calls.some((c) => c.method === "maybeSingle")) return { data: feedbackRow, error: null };
          if (calls.some((c) => c.method === "limit")) return { data: [{ last_error: "server_error", updated_at: "2026-11-02T10:00:00Z" }], error: null };
          const status = eq?.args[1];
          return { count: status === "created" ? counts.perDay : status === "pending" ? counts.pending : counts.failed, error: null };
        }).builder,
    };
  },
}));

import { resetRateLimits } from "../rate-limit";
import { getFeedbackStats, lookupFeedbackRef } from "./feedback";

const sessionWithRole = (role: string) => ({
  userId: "admin-1",
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role }, error: null }) }) }) }) },
});

beforeEach(() => {
  resetRateLimits();
  [notFound, session, logEvent, adminCreated, getUserById, createSignedUrl].forEach((m) => m.mockClear());
  session.mockResolvedValue(sessionWithRole("admin"));
  feedbackRow = { owner_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", created_at: "2026-11-01T10:00:00Z", kind: "bug", status: "created", issue_url: "https://github.com/a/b/issues/9", screenshot_path: "u/f.webp" };
  getUserById.mockResolvedValue({ data: { user: { email: "reporter@example.com" } } });
  createSignedUrl.mockResolvedValue({ data: { signedUrl: "https://storage.example/signed?token=x" } });
});

describe("lookupFeedbackRef", () => {
  it("needs an admin: others get forbidden, no audit and no query", async () => {
    session.mockResolvedValue(sessionWithRole("user"));
    expect(await lookupFeedbackRef("FB-k3x9p2qa")).toEqual({ ok: false, error: "forbidden" });
    session.mockResolvedValue(null);
    expect(await lookupFeedbackRef("FB-k3x9p2qa")).toEqual({ ok: false, error: "forbidden" });
    expect(adminCreated).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("returns the email, report data and a 5-minute signed URL, and audits the reference only", async () => {
    const r = await lookupFeedbackRef(" fb-K3X9P2QA ");
    expect(r).toEqual({
      ok: true,
      data: {
        ref: "FB-k3x9p2qa",
        email: "reporter@example.com",
        createdAt: "2026-11-01T10:00:00Z",
        kind: "bug",
        status: "created",
        issueUrl: "https://github.com/a/b/issues/9",
        screenshotUrl: "https://storage.example/signed?token=x",
      },
    });
    expect(createSignedUrl).toHaveBeenCalledWith("u/f.webp", 300);
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent).toHaveBeenCalledWith({ event: "admin.feedback_lookup", userId: "admin-1", route: "action:lookupFeedbackRef", props: { ref: "FB-k3x9p2qa" } });
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("reporter@example.com");
  });

  it("not found and invalid format give the same answer; both are audited", async () => {
    feedbackRow = null;
    const missing = await lookupFeedbackRef("FB-k3x9p2qa");
    const invalid = await lookupFeedbackRef("not a reference <script>");
    expect(missing).toEqual({ ok: false, error: "not_found" });
    expect(invalid).toEqual(missing);
    expect(logEvent).toHaveBeenCalledTimes(2);
    expect(logEvent.mock.calls[1][0].props).toEqual({ ref: null });
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("script");
  });

  it("no screenshot, no signed URL", async () => {
    feedbackRow = { ...(feedbackRow as object), screenshot_path: null };
    const r = await lookupFeedbackRef("FB-k3x9p2qa");
    expect(r.ok && r.data.screenshotUrl).toBeNull();
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});

describe("getFeedbackStats", () => {
  it("non-admins get the 404 page and no query runs", async () => {
    session.mockResolvedValue(sessionWithRole("user"));
    await expect(getFeedbackStats()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(adminCreated).not.toHaveBeenCalled();
  });

  it("returns 14 Berlin days of counts plus pending, failed and the last error class, with no identifiers", async () => {
    const s = await getFeedbackStats(new Date("2026-11-02T12:00:00Z"));
    expect(s.issuesPerDay).toHaveLength(14);
    expect(s.issuesPerDay[13]).toEqual({ day: "2026-11-02", count: 1 });
    expect(s.issuesPerDay[0].day).toBe("2026-10-20");
    expect(s.pending).toBe(4);
    expect(s.failed).toBe(2);
    expect(s.lastError).toEqual({ errorClass: "server_error", at: "2026-11-02T10:00:00Z" });
    expect(JSON.stringify(s)).not.toMatch(/FB-|owner|@|uuid/);
  });
});
