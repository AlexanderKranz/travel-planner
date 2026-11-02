import { beforeEach, describe, expect, it, vi } from "vitest";
import { chain } from "./test-support";

vi.mock("server-only", () => ({}));
const session = vi.fn();
vi.mock("../session", () => ({ getUserSession: () => session() }));

import { listMyFeedback } from "./mine";

let rows: unknown = [];
let error: unknown = null;
const calls: { method: string; args: unknown[] }[][] = [];
beforeEach(() => {
  calls.length = 0;
  error = null;
  session.mockResolvedValue({
    userId: "u1",
    supabase: {
      from: (table: string) => {
        expect(table).toBe("feedback");
        const c = chain(() => ({ data: rows, error }));
        calls.push(c.calls);
        return c.builder;
      },
    },
  });
});

describe("listMyFeedback", () => {
  it("is empty when signed out", async () => {
    session.mockResolvedValue(null);
    expect(await listMyFeedback()).toEqual([]);
  });
  it("maps rows: created -> published with link, pending and failed -> received without link; newest first, max 50", async () => {
    rows = [
      { ref: "FB-aaaaaaaa", kind: "bug", created_at: "2026-11-02T10:00:00Z", status: "created", issue_url: "https://github.com/a/b/issues/1" },
      { ref: "FB-bbbbbbbb", kind: "idea", created_at: "2026-11-01T10:00:00Z", status: "pending", issue_url: null },
      { ref: "FB-cccccccc", kind: "idea", created_at: "2026-10-31T10:00:00Z", status: "failed", issue_url: null },
      { ref: "broken", kind: "x" },
    ];
    expect(await listMyFeedback()).toEqual([
      { ref: "FB-aaaaaaaa", kind: "bug", createdAt: "2026-11-02T10:00:00Z", status: "published", issueUrl: "https://github.com/a/b/issues/1" },
      { ref: "FB-bbbbbbbb", kind: "idea", createdAt: "2026-11-01T10:00:00Z", status: "received", issueUrl: null },
      { ref: "FB-cccccccc", kind: "idea", createdAt: "2026-10-31T10:00:00Z", status: "received", issueUrl: null },
    ]);
    expect(calls[0].find((c) => c.method === "order")?.args).toEqual(["created_at", { ascending: false }]);
    expect(calls[0].find((c) => c.method === "limit")?.args).toEqual([50]);
  });
  it("is empty on a read error", async () => {
    error = { code: "x" };
    expect(await listMyFeedback()).toEqual([]);
  });
});
