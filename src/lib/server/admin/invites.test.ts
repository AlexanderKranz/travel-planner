import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
const adminSession = vi.fn();
vi.mock("./gate", () => ({ getAdminSession: () => adminSession() }));
const logEvent = vi.fn<(e: unknown) => Promise<void>>(async () => {});
vi.mock("../events", () => ({ logEvent: (e: unknown) => logEvent(e) }));
const inviteUserByEmail = vi.fn();
const listUsers = vi.fn();
const deleteUser = vi.fn();
const adminClientFactory = vi.fn(() => ({ auth: { admin: { inviteUserByEmail, listUsers, deleteUser } } }));
vi.mock("../supabase/admin", () => ({ createSupabaseAdminClient: () => adminClientFactory() }));

import { resetRateLimits } from "../rate-limit";
import { inviteUser, listInvites, revokeInvite } from "./invites";

type Calls = { insert: unknown[]; deleted: number[] };
function makeSession(opts: { rows?: unknown[]; insertError?: { code: string } | null; selectRow?: unknown; deleteError?: unknown } = {}) {
  const calls: Calls = { insert: [], deleted: [] };
  const supabase = {
    from: (table: string) => {
      if (table !== "signup_allowlist") throw new Error(`unexpected table ${table}`);
      return {
        insert: async (row: unknown) => {
          calls.insert.push(row);
          return { error: opts.insertError ?? null };
        },
        select: () => ({
          order: () => ({ limit: () => ({ returns: async () => ({ data: opts.rows ?? [], error: null }) }) }),
          eq: () => ({ maybeSingle: async () => ({ data: opts.selectRow ?? null, error: null }) }),
        }),
        delete: () => ({
          eq: async (_c: string, id: number) => {
            calls.deleted.push(id);
            return { error: opts.deleteError ?? null };
          },
        }),
      };
    },
  };
  return { calls, session: { userId: "admin-1", supabase } };
}

beforeEach(() => {
  adminSession.mockReset();
  logEvent.mockClear();
  inviteUserByEmail.mockReset();
  inviteUserByEmail.mockResolvedValue({ data: {}, error: null });
  listUsers.mockReset();
  listUsers.mockResolvedValue({ data: { users: [] }, error: null });
  deleteUser.mockReset();
  deleteUser.mockResolvedValue({ error: null });
  adminClientFactory.mockClear();
  resetRateLimits();
  process.env.APP_URL = "https://travel.example";
  delete process.env.DEMO_EMAIL;
});

describe("inviteUser", () => {
  it("is admin-only: a non-admin never reaches the Auth admin client", async () => {
    adminSession.mockResolvedValue(null);
    expect(await inviteUser({ email: "a@b.de", locale: "de" })).toEqual({ ok: false, error: "forbidden" });
    expect(adminClientFactory).not.toHaveBeenCalled();
  });

  it("validates the email", async () => {
    adminSession.mockResolvedValue(makeSession().session);
    const r = await inviteUser({ email: "not-an-email", locale: "de" });
    expect(r).toMatchObject({ ok: false, error: "invalid" });
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("allowlists first, then sends the invite with the app redirect and the locale", async () => {
    const { session, calls } = makeSession();
    adminSession.mockResolvedValue(session);
    expect(await inviteUser({ email: " Ana@Example.com ", locale: "en" })).toEqual({ ok: true });
    expect(calls.insert).toEqual([{ email: "ana@example.com", note: "invited by admin" }]);
    expect(inviteUserByEmail).toHaveBeenCalledWith("ana@example.com", {
      data: { locale: "en" },
      redirectTo: "https://travel.example/auth/confirm?locale=en&invited=1",
    });
  });

  it("resends for an address that is already on the allowlist", async () => {
    adminSession.mockResolvedValue(makeSession({ insertError: { code: "23505" } }).session);
    expect(await inviteUser({ email: "a@b.de", locale: "de" })).toEqual({ ok: true });
    expect(inviteUserByEmail).toHaveBeenCalledTimes(1);
  });

  it("fails without sending when the allowlist insert fails", async () => {
    adminSession.mockResolvedValue(makeSession({ insertError: { code: "42501" } }).session);
    expect(await inviteUser({ email: "a@b.de", locale: "de" })).toEqual({ ok: false, error: "failed" });
    expect(inviteUserByEmail).not.toHaveBeenCalled();
  });

  it("an existing account is reported, not duplicated", async () => {
    adminSession.mockResolvedValue(makeSession().session);
    inviteUserByEmail.mockResolvedValue({ data: null, error: { status: 422, code: "email_exists", message: "x" } });
    expect(await inviteUser({ email: "a@b.de", locale: "de" })).toEqual({ ok: false, error: "already_member" });
  });

  it("mail failure (built-in sender limit): the allowlist row stays, so the person can still sign in themselves", async () => {
    const { session, calls } = makeSession();
    adminSession.mockResolvedValue(session);
    inviteUserByEmail.mockResolvedValue({ data: null, error: { status: 429, code: "over_email_send_rate_limit", message: "x" } });
    expect(await inviteUser({ email: "a@b.de", locale: "de" })).toEqual({ ok: false, error: "email_failed" });
    expect(calls.insert).toHaveLength(1);
    expect(calls.deleted).toEqual([]);
  });

  it("rate limits invites per admin (11th within an hour)", async () => {
    adminSession.mockResolvedValue(makeSession().session);
    for (let i = 0; i < 10; i++) expect((await inviteUser({ email: `u${i}@b.de`, locale: "de" })).ok).toBe(true);
    expect(await inviteUser({ email: "u11@b.de", locale: "de" })).toEqual({ ok: false, error: "rate_limited" });
    expect(inviteUserByEmail).toHaveBeenCalledTimes(10);
  });

  it("never logs the email address", async () => {
    adminSession.mockResolvedValue(makeSession().session);
    await inviteUser({ email: "secret.person@b.de", locale: "de" });
    inviteUserByEmail.mockResolvedValue({ data: null, error: { status: 500, message: "secret.person@b.de" } });
    await inviteUser({ email: "secret.person@b.de", locale: "de" });
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("secret.person");
  });
});

describe("listInvites", () => {
  it("is admin-only", async () => {
    adminSession.mockResolvedValue(null);
    expect(await listInvites()).toEqual({ ok: false, error: "forbidden" });
  });

  it("marks pending vs accepted from the last sign-in, hides the demo address", async () => {
    process.env.DEMO_EMAIL = "demo@b.de";
    const rows = [
      { id: 3, email: "demo@b.de", note: "demo account", created_at: "2026-11-01T00:00:00Z" },
      { id: 2, email: "new@b.de", note: "invited by admin", created_at: "2026-11-01T00:00:00Z" },
      { id: 1, email: "Old@b.de", note: "owner", created_at: "2026-10-01T00:00:00Z" },
    ];
    adminSession.mockResolvedValue(makeSession({ rows }).session);
    listUsers.mockResolvedValue({
      data: { users: [{ id: "u-new", email: "new@b.de", last_sign_in_at: null }, { id: "u-old", email: "old@b.de", last_sign_in_at: "2026-10-02T00:00:00Z" }] },
      error: null,
    });
    const r = await listInvites();
    expect(r.ok && r.data.map((e) => [e.email, e.status, e.revocable])).toEqual([
      ["new@b.de", "pending", true],
      ["Old@b.de", "accepted", false],
    ]);
  });
});

describe("revokeInvite", () => {
  it("is admin-only", async () => {
    adminSession.mockResolvedValue(null);
    expect(await revokeInvite({ id: 1 })).toEqual({ ok: false, error: "forbidden" });
    expect(adminClientFactory).not.toHaveBeenCalled();
  });

  it("deletes the never-used account and the allowlist row", async () => {
    const { session, calls } = makeSession({ selectRow: { id: 2, email: "new@b.de" } });
    adminSession.mockResolvedValue(session);
    listUsers.mockResolvedValue({ data: { users: [{ id: "u-new", email: "new@b.de", last_sign_in_at: null }] }, error: null });
    expect(await revokeInvite({ id: 2 })).toEqual({ ok: true });
    expect(deleteUser).toHaveBeenCalledWith("u-new");
    expect(calls.deleted).toEqual([2]);
  });

  it("removes only the allowlist row when no account exists yet", async () => {
    const { session, calls } = makeSession({ selectRow: { id: 2, email: "new@b.de" } });
    adminSession.mockResolvedValue(session);
    expect(await revokeInvite({ id: 2 })).toEqual({ ok: true });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(calls.deleted).toEqual([2]);
  });

  it("never touches an account that has signed in", async () => {
    const { session, calls } = makeSession({ selectRow: { id: 1, email: "old@b.de" } });
    adminSession.mockResolvedValue(session);
    listUsers.mockResolvedValue({ data: { users: [{ id: "u-old", email: "old@b.de", last_sign_in_at: "2026-10-02T00:00:00Z" }] }, error: null });
    expect(await revokeInvite({ id: 1 })).toEqual({ ok: false, error: "conflict" });
    expect(deleteUser).not.toHaveBeenCalled();
    expect(calls.deleted).toEqual([]);
  });

  it("keeps the allowlist row when deleting the account fails", async () => {
    const { session, calls } = makeSession({ selectRow: { id: 2, email: "new@b.de" } });
    adminSession.mockResolvedValue(session);
    listUsers.mockResolvedValue({ data: { users: [{ id: "u-new", email: "new@b.de", last_sign_in_at: null }] }, error: null });
    deleteUser.mockResolvedValue({ error: { message: "boom" } });
    expect(await revokeInvite({ id: 2 })).toEqual({ ok: false, error: "failed" });
    expect(calls.deleted).toEqual([]);
  });

  it("refuses the demo address and unknown ids", async () => {
    process.env.DEMO_EMAIL = "demo@b.de";
    adminSession.mockResolvedValue(makeSession({ selectRow: { id: 9, email: "demo@b.de" } }).session);
    expect(await revokeInvite({ id: 9 })).toEqual({ ok: false, error: "forbidden" });
    adminSession.mockResolvedValue(makeSession({ selectRow: null }).session);
    expect(await revokeInvite({ id: 10 })).toEqual({ ok: false, error: "not_found" });
    expect(await revokeInvite({ id: -1 })).toMatchObject({ ok: false, error: "invalid" });
  });
});
