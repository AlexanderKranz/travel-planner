import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const logEvent = vi.fn<(e: unknown) => Promise<void>>(async () => {});
const deleteUser = vi.fn();
const signOut = vi.fn();
const getUserSession = vi.fn();
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));
vi.mock("./events", () => ({ logEvent: (e: unknown) => logEvent(e) }));
vi.mock("./session", () => ({ getUserSession: () => getUserSession() }));
const getUserById = vi.fn();
const allowlistEq = vi.fn();
const order: string[] = [];
vi.mock("./supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    auth: { admin: { deleteUser, getUserById } },
    from: (table: string) => ({
      delete: () => ({
        eq: (col: string, val: string) => {
          order.push(`delete:${table}`);
          return allowlistEq(col, val);
        },
      }),
    }),
  }),
}));

import { deleteAccount } from "./account";

beforeEach(() => {
  [logEvent, deleteUser, signOut, getUserSession, redirect, getUserById, allowlistEq].forEach((m) => m.mockClear());
  order.length = 0;
  getUserById.mockResolvedValue({ data: { user: { email: "Gone@Example.com" } } });
  allowlistEq.mockResolvedValue({ error: null });
  deleteUser.mockImplementation(async () => {
    order.push("deleteUser");
    return { error: null };
  });
  getUserSession.mockResolvedValue({ userId: "11111111-1111-4111-8111-111111111111", supabase: { auth: { signOut } } });
  signOut.mockResolvedValue({});
});

describe("deleteAccount", () => {
  it("removes the invite (lowercased email) before deleting the user", async () => {
    await expect(deleteAccount("de")).rejects.toThrow("REDIRECT:/de");
    expect(allowlistEq).toHaveBeenCalledWith("email", "gone@example.com");
    expect(order).toEqual(["delete:signup_allowlist", "deleteUser"]);
  });
  it("does not delete the user when the invite cannot be removed", async () => {
    allowlistEq.mockResolvedValue({ error: { message: "x" } });
    expect(await deleteAccount("de")).toEqual({ ok: false, error: "failed" });
    expect(deleteUser).not.toHaveBeenCalled();
  });
  it("refuses when signed out and never touches the admin client", async () => {
    getUserSession.mockResolvedValue(null);
    expect(await deleteAccount("de")).toEqual({ ok: false, error: "unauthenticated" });
    expect(deleteUser).not.toHaveBeenCalled();
  });
  it("deletes only the session's own user id (no client-supplied id exists)", async () => {
    await expect(deleteAccount("en")).rejects.toThrow("REDIRECT:/en");
    expect(deleteUser).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(deleteAccount.length).toBe(1);
  });
  it("sanitises the redirect locale", async () => {
    await expect(deleteAccount("//evil.com")).rejects.toThrow("REDIRECT:/de");
  });
  it("returns failed and logs without PII when deletion fails; no redirect", async () => {
    deleteUser.mockResolvedValue({ error: { status: 500, message: "user@example.com" } });
    expect(await deleteAccount("de")).toEqual({ ok: false, error: "failed" });
    expect(redirect).not.toHaveBeenCalled();
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("example.com");
  });
  it("still redirects if the local sign-out throws after deletion", async () => {
    signOut.mockRejectedValue(new Error("user not found"));
    await expect(deleteAccount("de")).rejects.toThrow("REDIRECT:/de");
  });
  it("logs account.deleted without a user id", async () => {
    await expect(deleteAccount("de")).rejects.toThrow();
    expect(logEvent).toHaveBeenCalledWith({ event: "account.deleted" });
  });
});
