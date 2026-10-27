import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const insert = vi.fn();
vi.mock("./supabase/admin", () => ({
  createSupabaseAdminClient: () => ({ from: (t: string) => ({ insert: (row: unknown) => insert(t, row) }) }),
}));

import { logEvent } from "./events";

beforeEach(() => {
  insert.mockReset();
  vi.restoreAllMocks();
});

describe("logEvent", () => {
  it("writes to app_events with defaults", async () => {
    insert.mockResolvedValue({ error: null });
    await logEvent({ event: "group.created", props: { entries: 2 } });
    expect(insert).toHaveBeenCalledWith("app_events", {
      event: "group.created",
      level: "info",
      user_id: null,
      route: null,
      request_id: null,
      props: { entries: 2 },
    });
  });
  it("never throws when the insert errors or the client throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    insert.mockResolvedValue({ error: { code: "42501", message: "contains user@example.com" } });
    await expect(logEvent({ event: "a.b" })).resolves.toBeUndefined();
    insert.mockRejectedValue(new Error("boom user@example.com"));
    await expect(logEvent({ event: "a.b" })).resolves.toBeUndefined();
  });
  it("does not echo error messages (which may hold PII) to the console", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    insert.mockResolvedValue({ error: { code: "23505", message: "Key (email)=(user@example.com) exists" } });
    await logEvent({ event: "a.b" });
    insert.mockRejectedValue(new Error("user@example.com"));
    await logEvent({ event: "a.b" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("user@example.com");
  });
  it("uses event names accepted by the DB check (^[a-z0-9_]+(\\.[a-z0-9_]+)+$)", () => {
    const re = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;
    for (const e of ["auth.signup", "auth.login_failed", "auth.login_requested", "auth.signup_rejected", "auth.rate_limited", "error.auth", "error.account_delete", "account.deleted", "group.created", "purpose.created"]) {
      expect(e).toMatch(re);
    }
  });
});
