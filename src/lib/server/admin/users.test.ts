import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const adminSession = vi.fn();
vi.mock("./gate", () => ({ getAdminSession: () => adminSession() }));
const logEvent = vi.fn<(e: unknown) => Promise<void>>(async () => {});
vi.mock("../events", () => ({ logEvent: (e: unknown) => logEvent(e) }));
const removeUserAccount = vi.fn();
vi.mock("../user-removal", () => ({ removeUserAccount: (id: string) => removeUserAccount(id) }));

const updateUserById = vi.fn();
const listAuthUsers = vi.fn();
const profileRead = vi.fn(); // maybeSingle of the guard read
const profileList = vi.fn(); // list read
const updates: { value: unknown; id: string }[] = [];
const updateResults: ({ error: unknown } | undefined)[] = [];
vi.mock("../supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    auth: { admin: { updateUserById, listUsers: listAuthUsers } },
    from: (table: string) => {
      if (table !== "profiles") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({ maybeSingle: () => profileRead() }),
          limit: () => ({ returns: () => profileList() }),
        }),
        update: (v: { disabled_at: unknown }) => ({
          eq: async (_c: string, id: string) => {
            updates.push({ value: v.disabled_at, id });
            return updateResults.shift() ?? { error: null };
          },
        }),
      };
    },
  }),
}));

import { deleteUserAsAdmin, disableUser, enableUser, listUsers } from "./users";

const ADMIN = "00000000-0000-4000-8000-0000000000aa";
const TARGET = "11111111-1111-4111-8111-111111111111";
const actions = [
  ["disableUser", disableUser],
  ["enableUser", enableUser],
  ["deleteUserAsAdmin", deleteUserAsAdmin],
] as const;

beforeEach(() => {
  [adminSession, logEvent, updateUserById, listAuthUsers, profileRead, profileList, removeUserAccount].forEach((m) => m.mockReset());
  logEvent.mockResolvedValue(undefined);
  updates.length = 0;
  updateResults.length = 0;
  adminSession.mockResolvedValue({ userId: ADMIN });
  profileRead.mockResolvedValue({ data: { role: "user", is_demo: false }, error: null });
  updateUserById.mockResolvedValue({ error: null });
  removeUserAccount.mockResolvedValue({ ok: true });
});

describe.each(actions)("%s guards", (_name, action) => {
  it("needs an admin session", async () => {
    adminSession.mockResolvedValue(null);
    expect(await action({ userId: TARGET })).toEqual({ ok: false, error: "forbidden" });
    expect(profileRead).not.toHaveBeenCalled();
  });
  it("validates the id with Zod", async () => {
    const r = await action({ userId: "not-a-uuid" });
    expect(r).toMatchObject({ ok: false, error: "invalid" });
    expect(updateUserById).not.toHaveBeenCalled();
  });
  it("never yourself", async () => {
    expect(await action({ userId: ADMIN })).toEqual({ ok: false, error: "protected" });
    expect(updates).toHaveLength(0);
    expect(updateUserById).not.toHaveBeenCalled();
    expect(removeUserAccount).not.toHaveBeenCalled();
  });
  it("never the demo account", async () => {
    profileRead.mockResolvedValue({ data: { role: "user", is_demo: true }, error: null });
    expect(await action({ userId: TARGET })).toEqual({ ok: false, error: "protected" });
    expect(updateUserById).not.toHaveBeenCalled();
    expect(removeUserAccount).not.toHaveBeenCalled();
  });
  it("never another admin", async () => {
    profileRead.mockResolvedValue({ data: { role: "admin", is_demo: false }, error: null });
    expect(await action({ userId: TARGET })).toEqual({ ok: false, error: "protected" });
    expect(updateUserById).not.toHaveBeenCalled();
    expect(removeUserAccount).not.toHaveBeenCalled();
  });
  it("fails closed when the role cannot be read", async () => {
    profileRead.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await action({ userId: TARGET })).toEqual({ ok: false, error: "failed" });
    expect(updateUserById).not.toHaveBeenCalled();
    expect(removeUserAccount).not.toHaveBeenCalled();
  });
  it("fails closed on a missing role value", async () => {
    profileRead.mockResolvedValue({ data: { role: null, is_demo: false }, error: null });
    expect(await action({ userId: TARGET })).toEqual({ ok: false, error: "protected" });
  });
  it("unknown user is not_found", async () => {
    profileRead.mockResolvedValue({ data: null, error: null });
    expect(await action({ userId: TARGET })).toEqual({ ok: false, error: "not_found" });
  });
});

describe("disableUser", () => {
  it("sets the flag, then bans, then logs without target identity", async () => {
    expect(await disableUser({ userId: TARGET })).toEqual({ ok: true });
    expect(updates).toEqual([{ value: expect.any(String), id: TARGET }]);
    expect(updateUserById).toHaveBeenCalledWith(TARGET, { ban_duration: "876000h" });
    expect(logEvent).toHaveBeenCalledWith({ event: "admin.user_disabled", userId: ADMIN, route: "action:disableUser" });
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain(TARGET);
  });
  it("does not ban when the flag cannot be set", async () => {
    updateResults.push({ error: { message: "x" } });
    expect(await disableUser({ userId: TARGET })).toEqual({ ok: false, error: "failed" });
    expect(updateUserById).not.toHaveBeenCalled();
  });
  it("rolls the flag back when the ban fails", async () => {
    updateUserById.mockResolvedValue({ error: { status: 500 } });
    expect(await disableUser({ userId: TARGET })).toEqual({ ok: false, error: "failed" });
    expect(updates.map((u) => u.value)).toEqual([expect.any(String), null]);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "error.user_disable", props: expect.objectContaining({ rolledBack: true }) }));
    expect(logEvent).not.toHaveBeenCalledWith(expect.objectContaining({ event: "admin.user_disabled" }));
  });
  it("reports a failed rollback in the event (account stays disabled)", async () => {
    updateUserById.mockResolvedValue({ error: { status: 500 } });
    updateResults.push({ error: null }, { error: { message: "x" } });
    expect(await disableUser({ userId: TARGET })).toEqual({ ok: false, error: "failed" });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({ rolledBack: false }) }));
  });
});

describe("enableUser", () => {
  it("unbans, then clears the flag", async () => {
    expect(await enableUser({ userId: TARGET })).toEqual({ ok: true });
    expect(updateUserById).toHaveBeenCalledWith(TARGET, { ban_duration: "none" });
    expect(updates).toEqual([{ value: null, id: TARGET }]);
    expect(logEvent).toHaveBeenCalledWith({ event: "admin.user_enabled", userId: ADMIN, route: "action:enableUser" });
  });
  it("leaves the flag alone when the unban fails", async () => {
    updateUserById.mockResolvedValue({ error: { status: 500 } });
    expect(await enableUser({ userId: TARGET })).toEqual({ ok: false, error: "failed" });
    expect(updates).toHaveLength(0);
  });
  it("re-bans when the flag cannot be cleared, so both stay disabled", async () => {
    updateResults.push({ error: { message: "x" } });
    expect(await enableUser({ userId: TARGET })).toEqual({ ok: false, error: "failed" });
    expect(updateUserById.mock.calls.map((c) => (c[1] as { ban_duration: string }).ban_duration)).toEqual(["none", "876000h"]);
    expect(logEvent).not.toHaveBeenCalledWith(expect.objectContaining({ event: "admin.user_enabled" }));
  });
});

describe("deleteUserAsAdmin", () => {
  it("deletes through the shared helper and logs without target identity", async () => {
    expect(await deleteUserAsAdmin({ userId: TARGET })).toEqual({ ok: true });
    expect(removeUserAccount).toHaveBeenCalledWith(TARGET);
    expect(logEvent).toHaveBeenCalledWith({ event: "admin.user_deleted", userId: ADMIN, route: "action:deleteUserAsAdmin" });
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain(TARGET);
  });
  it("reports failure and does not log success", async () => {
    removeUserAccount.mockResolvedValue({ ok: false, step: "delete", status: 500 });
    expect(await deleteUserAsAdmin({ userId: TARGET })).toEqual({ ok: false, error: "failed" });
    expect(logEvent).not.toHaveBeenCalledWith(expect.objectContaining({ event: "admin.user_deleted" }));
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "error.user_delete" }));
  });
});

describe("listUsers", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  it("needs an admin", async () => {
    adminSession.mockResolvedValue(null);
    expect(await listUsers()).toEqual({ ok: false, error: "forbidden" });
  });
  it("maps status and marks protected rows", async () => {
    listAuthUsers.mockResolvedValue({
      data: {
        users: [
          { id: ADMIN, email: "admin@x.dev", last_sign_in_at: "2026-10-30T00:00:00Z" },
          { id: TARGET, email: "b@x.dev", last_sign_in_at: null },
          { id: "22222222-2222-4222-8222-222222222222", email: "a@x.dev", banned_until: future },
          { id: "33333333-3333-4333-8333-333333333333", email: "demo@x.dev" },
          { id: "44444444-4444-4444-8444-444444444444", email: "flag@x.dev" },
        ],
      },
      error: null,
    });
    profileList.mockResolvedValue({
      data: [
        { id: ADMIN, role: "admin", is_demo: false, disabled_at: null },
        { id: TARGET, role: "user", is_demo: false, disabled_at: null },
        { id: "22222222-2222-4222-8222-222222222222", role: "user", is_demo: false, disabled_at: null },
        { id: "33333333-3333-4333-8333-333333333333", role: "user", is_demo: true, disabled_at: null },
        { id: "44444444-4444-4444-8444-444444444444", role: "user", is_demo: false, disabled_at: "2026-10-31T00:00:00Z" },
      ],
      error: null,
    });
    const r = await listUsers();
    if (!r.ok) throw new Error("expected ok");
    const byEmail = Object.fromEntries(r.data.map((u) => [u.email, u]));
    expect(r.data.map((u) => u.email)).toEqual(["a@x.dev", "admin@x.dev", "b@x.dev", "demo@x.dev", "flag@x.dev"]);
    expect(byEmail["admin@x.dev"]).toMatchObject({ isSelf: true, isAdmin: true, manageable: false });
    expect(byEmail["b@x.dev"]).toMatchObject({ status: "active", manageable: true, lastSignInAt: null });
    expect(byEmail["a@x.dev"]).toMatchObject({ status: "disabled", manageable: true });
    expect(byEmail["demo@x.dev"]).toMatchObject({ isDemo: true, manageable: false });
    expect(byEmail["flag@x.dev"]).toMatchObject({ status: "disabled" });
  });
  it("users without a profile row are not manageable", async () => {
    listAuthUsers.mockResolvedValue({ data: { users: [{ id: TARGET, email: "b@x.dev" }] }, error: null });
    profileList.mockResolvedValue({ data: [], error: null });
    const r = await listUsers();
    expect(r).toMatchObject({ ok: true, data: [{ manageable: false }] });
  });
});
