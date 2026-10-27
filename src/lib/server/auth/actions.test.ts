import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const logEvent = vi.fn<(e: unknown) => Promise<void>>(async () => {});
const signInWithOtp = vi.fn();
const verifyOtp = vi.fn();
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "travel.example", "x-forwarded-proto": "https" }),
}));
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));
vi.mock("@/lib/server/events", () => ({ logEvent: (e: unknown) => logEvent(e) }));
vi.mock("@/lib/server/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { signInWithOtp, verifyOtp, signOut: vi.fn() } }),
}));

import { requestLogin, signOut, verifyLoginCode } from "./actions";

beforeEach(() => {
  logEvent.mockClear();
  signInWithOtp.mockReset();
  verifyOtp.mockReset();
  redirect.mockClear();
});

describe("requestLogin", () => {
  it("encodes the locale in emailRedirectTo (works for existing users)", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: null });
    await requestLogin({ email: "a@b.de", locale: "en" });
    expect(signInWithOtp.mock.calls[0][0].options.emailRedirectTo).toBe(
      "https://travel.example/auth/confirm?locale=en",
    );
  });
  it("gives the same neutral answer for invited and non-invited addresses", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: null });
    const invited = await requestLogin({ email: "a@b.de", locale: "de" });
    signInWithOtp.mockResolvedValueOnce({ error: { status: 403, message: "signup_not_allowed" } });
    const stranger = await requestLogin({ email: "x@y.de", locale: "de" });
    expect(stranger).toEqual(invited);
    expect(stranger).toEqual({ ok: true });
  });
  it("matches the hook error by message even if the status differs", async () => {
    signInWithOtp.mockResolvedValue({ error: { status: 422, message: "Hook: signup_not_allowed" } });
    expect(await requestLogin({ email: "x@y.de", locale: "de" })).toEqual({ ok: true });
  });
  it("reports real failures and rate limits as failed", async () => {
    signInWithOtp.mockResolvedValue({ error: { status: 429, message: "slow down" } });
    expect(await requestLogin({ email: "a@b.de", locale: "de" })).toEqual({ ok: false, error: "failed" });
    signInWithOtp.mockResolvedValue({ error: { status: 500, message: "db down", code: "unexpected_failure" } });
    expect(await requestLogin({ email: "a@b.de", locale: "de" })).toEqual({ ok: false, error: "failed" });
  });
  it("rejects invalid input without calling Supabase", async () => {
    const res = await requestLogin({ email: "nope", locale: "de" });
    expect(res.ok).toBe(false);
    expect(signInWithOtp).not.toHaveBeenCalled();
  });
  it("never logs the email address", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: null });
    await requestLogin({ email: "secret.person@example.com", locale: "de" });
    signInWithOtp.mockResolvedValueOnce({ error: { status: 403, message: "signup_not_allowed secret.person@example.com" } });
    await requestLogin({ email: "secret.person@example.com", locale: "de" });
    signInWithOtp.mockResolvedValueOnce({ error: { status: 500, message: "secret.person@example.com", code: "x" } });
    await requestLogin({ email: "secret.person@example.com", locale: "de" });
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("secret.person");
  });
  it("passes the locale as user metadata for the signup trigger / email template", async () => {
    signInWithOtp.mockResolvedValue({ error: null });
    await requestLogin({ email: "a@b.de", locale: "en" });
    expect(signInWithOtp).toHaveBeenCalledWith({
      email: "a@b.de",
      options: {
        shouldCreateUser: true,
        emailRedirectTo: "https://travel.example/auth/confirm?locale=en",
        data: { locale: "en" },
      },
    });
  });
});

describe("verifyLoginCode", () => {
  it("redirects into the app on success and logs no email", async () => {
    verifyOtp.mockResolvedValue({ data: { user: { id: "u1", email: "a@b.de" } }, error: null });
    await expect(verifyLoginCode({ email: "a@b.de", code: "123456", locale: "en" })).rejects.toThrow("REDIRECT:/en/app");
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("@");
  });
  it("returns invalid for a wrong code and does not redirect", async () => {
    verifyOtp.mockResolvedValue({ data: { user: null }, error: { status: 403, message: "Token has expired" } });
    expect(await verifyLoginCode({ email: "a@b.de", code: "123456", locale: "en" })).toEqual({ ok: false, error: "invalid" });
    expect(redirect).not.toHaveBeenCalled();
  });
  it("rejects a malformed code before calling Supabase", async () => {
    await verifyLoginCode({ email: "a@b.de", code: "12 3456", locale: "en" });
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

describe("signOut", () => {
  it("sanitises the locale in the redirect target", async () => {
    await expect(signOut("//evil.com")).rejects.toThrow("REDIRECT:/de/login");
    await expect(signOut("en")).rejects.toThrow("REDIRECT:/en/login");
  });
});
