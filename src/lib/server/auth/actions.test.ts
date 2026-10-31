import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const logEvent = vi.fn<(e: unknown) => Promise<void>>(async () => {});
const signInWithOtp = vi.fn();
const verifyOtp = vi.fn();
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
const hdr = vi.hoisted(() => ({ extra: {} as Record<string, string> }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "evil.example", "x-forwarded-host": "evil.example", ...hdr.extra }),
}));
const signInWithPassword = vi.fn();
const resetPasswordForEmail = vi.fn();
const updateUser = vi.fn();
const getClaims = vi.fn();
const isDemoRow = vi.fn();
const authSignOut = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (u: string) => redirect(u) }));
vi.mock("@/lib/server/events", () => ({ logEvent: (e: unknown) => logEvent(e) }));
vi.mock("@/lib/server/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { signInWithOtp, verifyOtp, signInWithPassword, resetPasswordForEmail, updateUser, getClaims, signOut: authSignOut },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => isDemoRow() }) }) }),
  }),
}));

import { resetRateLimits } from "@/lib/server/rate-limit";
import {
  requestLogin,
  requestPasswordReset,
  setPassword,
  signInDemo,
  signInWithPasswordAction,
  signOut,
  verifyLoginCode,
} from "./actions";

beforeEach(() => {
  resetRateLimits();
  hdr.extra = {};
  vi.stubEnv("APP_URL", "https://travel.example");
  signInWithPassword.mockReset();
  resetPasswordForEmail.mockReset();
  updateUser.mockReset();
  getClaims.mockReset();
  isDemoRow.mockReset();
  authSignOut.mockReset();
  authSignOut.mockResolvedValue({ error: null });
  logEvent.mockClear();
  signInWithOtp.mockReset();
  verifyOtp.mockReset();
  redirect.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requestLogin", () => {
  it("encodes the locale in emailRedirectTo (works for existing users)", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: null });
    await requestLogin({ email: "a@b.de", locale: "en" });
    expect(signInWithOtp.mock.calls[0][0].options.emailRedirectTo).toBe(
      "https://travel.example/auth/confirm?locale=en",
    );
  });
  it("ignores spoofed Host headers and uses the configured base URL", async () => {
    signInWithOtp.mockResolvedValueOnce({ error: null });
    await requestLogin({ email: "a@b.de", locale: "de" });
    expect(JSON.stringify(signInWithOtp.mock.calls)).not.toContain("evil.example");
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
  it("keeps a Supabase 429 neutral (it would reveal a mail was recently sent to this address)", async () => {
    signInWithOtp.mockResolvedValue({ error: { status: 429, message: "slow down" } });
    expect(await requestLogin({ email: "a@b.de", locale: "de" })).toEqual({ ok: true });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "auth.rate_limited" }));
  });
  it("reports real failures as failed", async () => {
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

describe("signInDemo", () => {
  const enable = () => {
    vi.stubEnv("DEMO_ENABLED", "true");
    vi.stubEnv("DEMO_EMAIL", "demo@example.com");
    vi.stubEnv("DEMO_PASSWORD", "s3cret-pw");
  };
  it("fails without touching Supabase when the demo is disabled", async () => {
    vi.stubEnv("DEMO_ENABLED", "false");
    expect(await signInDemo("de")).toEqual({ ok: false, error: "failed" });
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
  it("signs in server-side, redirects and logs no PII or password", async () => {
    enable();
    signInWithPassword.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    await expect(signInDemo("en")).rejects.toThrow("REDIRECT:/en/app");
    expect(signInWithPassword).toHaveBeenCalledWith({ email: "demo@example.com", password: "s3cret-pw" });
    const logged = JSON.stringify(logEvent.mock.calls);
    expect(logged).toContain("auth.demo_login");
    expect(logged).not.toContain("s3cret");
    expect(logged).not.toContain("@");
  });
  it("returns failed when sign-in fails", async () => {
    enable();
    signInWithPassword.mockResolvedValue({ data: { user: null }, error: { status: 400, message: "bad s3cret-pw" } });
    expect(await signInDemo("de")).toEqual({ ok: false, error: "failed" });
    expect(redirect).not.toHaveBeenCalled();
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("s3cret");
  });
});

describe("rate limits on the unauthenticated actions", () => {
  it("requestLogin: 3 mails per address per 10 minutes, then rate_limited without calling Supabase", async () => {
    signInWithOtp.mockResolvedValue({ error: null });
    for (let i = 0; i < 3; i++) expect(await requestLogin({ email: "a@b.de", locale: "de" })).toEqual({ ok: true });
    expect(await requestLogin({ email: "A@b.de", locale: "de" })).toEqual({ ok: false, error: "rate_limited" });
    expect(signInWithOtp).toHaveBeenCalledTimes(3);
    expect(await requestLogin({ email: "other@b.de", locale: "de" })).toEqual({ ok: true });
  });
  it("requestLogin: 10 requests per IP per 10 minutes, whatever the address", async () => {
    hdr.extra = { "x-forwarded-for": "203.0.113.9" };
    signInWithOtp.mockResolvedValue({ error: null });
    for (let i = 0; i < 10; i++) expect((await requestLogin({ email: `u${i}@b.de`, locale: "de" })).ok).toBe(true);
    expect(await requestLogin({ email: "u11@b.de", locale: "de" })).toEqual({ ok: false, error: "rate_limited" });
  });
  it("the limit does not depend on whether the address is invited (neutral answer stays neutral)", async () => {
    signInWithOtp.mockResolvedValue({ error: { status: 403, message: "signup_not_allowed" } });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await requestLogin({ email: "x@y.de", locale: "de" }));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
  });
  it("verifyLoginCode: 10 guesses per address per 10 minutes", async () => {
    verifyOtp.mockResolvedValue({ data: { user: null }, error: { status: 403 } });
    for (let i = 0; i < 10; i++) expect(await verifyLoginCode({ email: "a@b.de", code: "123456", locale: "de" })).toEqual({ ok: false, error: "invalid" });
    expect(await verifyLoginCode({ email: "a@b.de", code: "123456", locale: "de" })).toEqual({ ok: false, error: "rate_limited" });
    expect(verifyOtp).toHaveBeenCalledTimes(10);
  });
  it("signInDemo: 20 per IP per 10 minutes", async () => {
    vi.stubEnv("DEMO_ENABLED", "true");
    vi.stubEnv("DEMO_EMAIL", "demo@example.com");
    vi.stubEnv("DEMO_PASSWORD", "pw");
    hdr.extra = { "x-forwarded-for": "203.0.113.10" };
    signInWithPassword.mockResolvedValue({ data: { user: null }, error: { status: 400 } });
    for (let i = 0; i < 20; i++) await signInDemo("de");
    expect(await signInDemo("de")).toEqual({ ok: false, error: "rate_limited" });
    expect(signInWithPassword).toHaveBeenCalledTimes(20);
  });
});

describe("signInWithPasswordAction", () => {
  const input = { email: "secret.person@example.com", password: "hunter2-hunter2", locale: "en" };
  const NEUTRAL = { ok: false, error: "invalid_credentials" };

  it("signs in on the cookie-bound client, redirects, logs method password and no PII", async () => {
    signInWithPassword.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    await expect(signInWithPasswordAction(input)).rejects.toThrow("REDIRECT:/en/app");
    expect(signInWithPassword).toHaveBeenCalledWith({ email: input.email, password: input.password });
    const logged = JSON.stringify(logEvent.mock.calls);
    expect(logged).toContain("auth.login");
    expect(logged).toContain('"method":"password"');
    expect(logged).not.toContain("secret.person");
    expect(logged).not.toContain("hunter2");
  });
  it("gives the same neutral error for wrong email, wrong password, no password and banned user", async () => {
    const errors = [
      { status: 400, code: "invalid_credentials", message: "Invalid login credentials" },
      { status: 400, code: "invalid_credentials", message: "wrong password" },
      { status: 400, code: "invalid_credentials", message: "no password set" },
      { status: 403, code: "user_banned", message: "User is banned" },
    ];
    for (const [i, error] of errors.entries()) {
      signInWithPassword.mockResolvedValueOnce({ data: { user: null }, error });
      expect(await signInWithPasswordAction({ ...input, email: `x${i}@b.de` })).toEqual(NEUTRAL);
    }
    expect(redirect).not.toHaveBeenCalled();
  });
  it("logs auth.login_failed with status only", async () => {
    signInWithPassword.mockResolvedValue({ data: { user: null }, error: { status: 400, message: "secret.person hunter2" } });
    await signInWithPasswordAction(input);
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "auth.login_failed", props: { method: "password", status: 400 } }),
    );
    const logged = JSON.stringify(logEvent.mock.calls);
    expect(logged).not.toContain("secret.person");
    expect(logged).not.toContain("hunter2");
  });
  it("answers malformed input with the same neutral error, without calling Supabase", async () => {
    expect(await signInWithPasswordAction({ ...input, email: "nope" })).toEqual(NEUTRAL);
    expect(await signInWithPasswordAction({ ...input, password: "" })).toEqual(NEUTRAL);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
  it("rate limits: 5 attempts per address per 10 minutes", async () => {
    signInWithPassword.mockResolvedValue({ data: { user: null }, error: { status: 400 } });
    for (let i = 0; i < 5; i++) expect(await signInWithPasswordAction(input)).toEqual(NEUTRAL);
    expect(await signInWithPasswordAction({ ...input, email: "SECRET.person@example.com" })).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(signInWithPassword).toHaveBeenCalledTimes(5);
  });
  it("rate limits: 20 attempts per IP per 10 minutes", async () => {
    hdr.extra = { "x-forwarded-for": "203.0.113.20" };
    signInWithPassword.mockResolvedValue({ data: { user: null }, error: { status: 400 } });
    for (let i = 0; i < 20; i++) await signInWithPasswordAction({ ...input, email: `u${i}@b.de` });
    expect(await signInWithPasswordAction({ ...input, email: "u99@b.de" })).toEqual({ ok: false, error: "rate_limited" });
    expect(signInWithPassword).toHaveBeenCalledTimes(20);
  });
});

describe("requestPasswordReset", () => {
  it("sends the reset mail with a redirect to /auth/confirm that lands on the settings password section", async () => {
    resetPasswordForEmail.mockResolvedValue({ error: null });
    expect(await requestPasswordReset({ email: "a@b.de", locale: "en" })).toEqual({ ok: true });
    const [email, opts] = resetPasswordForEmail.mock.calls[0];
    expect(email).toBe("a@b.de");
    const url = new URL(opts.redirectTo);
    expect(url.origin + url.pathname).toBe("https://travel.example/auth/confirm");
    expect(url.searchParams.get("locale")).toBe("en");
    expect(url.searchParams.get("next")).toBe("/en/settings?focus=password");
    expect(JSON.stringify(resetPasswordForEmail.mock.calls)).not.toContain("evil.example");
  });
  it("is a silent no-op for the demo account address (any case), with the same answer", async () => {
    vi.stubEnv("DEMO_EMAIL", "Demo@Example.com");
    expect(await requestPasswordReset({ email: "demo@example.com", locale: "de" })).toEqual({ ok: true });
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
    vi.stubEnv("DEMO_ENABLED", "false"); // also when the demo is switched off
    expect(await requestPasswordReset({ email: "demo@example.com", locale: "de" })).toEqual({ ok: true });
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });
  it("answers the same whether or not the address has an account, and never logs it", async () => {
    resetPasswordForEmail.mockResolvedValue({ error: null });
    const known = await requestPasswordReset({ email: "secret.person@example.com", locale: "de" });
    const unknown = await requestPasswordReset({ email: "nobody@example.com", locale: "de" });
    expect(unknown).toEqual(known);
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("secret.person");
  });
  it("shares the login mail limit: 3 per address per 10 minutes", async () => {
    resetPasswordForEmail.mockResolvedValue({ error: null });
    signInWithOtp.mockResolvedValue({ error: null });
    await requestLogin({ email: "a@b.de", locale: "de" });
    await requestLogin({ email: "a@b.de", locale: "de" });
    expect(await requestPasswordReset({ email: "a@b.de", locale: "de" })).toEqual({ ok: true });
    expect(await requestPasswordReset({ email: "a@b.de", locale: "de" })).toEqual({ ok: false, error: "rate_limited" });
    expect(resetPasswordForEmail).toHaveBeenCalledTimes(1);
  });
  it("keeps a Supabase 429 neutral and logs it; other errors are failed", async () => {
    resetPasswordForEmail.mockResolvedValueOnce({ error: { status: 429, message: "slow down" } });
    expect(await requestPasswordReset({ email: "a@b.de", locale: "de" })).toEqual({ ok: true });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "auth.rate_limited" }));
    resetPasswordForEmail.mockResolvedValueOnce({ error: { status: 500, message: "db", code: "x" } });
    expect(await requestPasswordReset({ email: "b@b.de", locale: "de" })).toEqual({ ok: false, error: "failed" });
  });
  it("fails closed without a base URL (the link would lose `next`)", async () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("VERCEL_ENV", "");
    expect(await requestPasswordReset({ email: "a@b.de", locale: "de" })).toEqual({ ok: false, error: "failed" });
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });
  it("rejects an invalid address without calling Supabase", async () => {
    expect((await requestPasswordReset({ email: "nope", locale: "de" })).ok).toBe(false);
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });
});

describe("setPassword", () => {
  const good = { password: "correct-horse-battery", confirm: "correct-horse-battery" };
  const signedIn = () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "u1" } } });
    isDemoRow.mockResolvedValue({ data: { is_demo: false }, error: null });
  };

  it("updates the password through the session client and logs no password", async () => {
    signedIn();
    updateUser.mockResolvedValue({ error: null });
    expect(await setPassword(good)).toEqual({ ok: true });
    expect(updateUser).toHaveBeenCalledWith({ password: good.password });
    expect(JSON.stringify(logEvent.mock.calls)).not.toContain("correct-horse");
  });
  it("validates length (10..72) and the confirm field before touching Supabase", async () => {
    signedIn();
    updateUser.mockResolvedValue({ error: null });
    expect((await setPassword({ password: "short", confirm: "short" })).ok).toBe(false);
    expect((await setPassword({ password: "a".repeat(73), confirm: "a".repeat(73) })).ok).toBe(false);
    expect(await setPassword({ ...good, confirm: "something-else-1" })).toMatchObject({ ok: false, error: "invalid" });
    expect(updateUser).not.toHaveBeenCalled();
    expect((await setPassword({ password: "a".repeat(72), confirm: "a".repeat(72) })).ok).toBe(true);
    expect((await setPassword({ password: "a".repeat(10), confirm: "a".repeat(10) })).ok).toBe(true);
  });
  it("counts bcrypt's 72 limit in bytes, not characters", async () => {
    signedIn();
    updateUser.mockResolvedValue({ error: null });
    const umlauts = "ä".repeat(37); // 37 chars, 74 bytes
    expect(await setPassword({ password: umlauts, confirm: umlauts })).toMatchObject({ ok: false, error: "invalid" });
    const ok = "ä".repeat(36); // 72 bytes
    expect((await setPassword({ password: ok, confirm: ok })).ok).toBe(true);
  });
  it("signs out all other sessions after a successful change", async () => {
    signedIn();
    updateUser.mockResolvedValue({ error: null });
    await setPassword(good);
    expect(authSignOut).toHaveBeenCalledWith({ scope: "others" });
  });
  it("does not sign out others when the change failed", async () => {
    signedIn();
    updateUser.mockResolvedValue({ error: { status: 500, code: "x", message: "x" } });
    await setPassword(good);
    expect(authSignOut).not.toHaveBeenCalled();
  });
  it("still reports success if signing out others fails, and logs it", async () => {
    signedIn();
    updateUser.mockResolvedValue({ error: null });
    authSignOut.mockResolvedValue({ error: { status: 500, code: "boom", message: "x" } });
    expect(await setPassword(good)).toEqual({ ok: true });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "auth.signout_others_failed" }));
  });
  it("requires a session", async () => {
    getClaims.mockResolvedValue({ data: null });
    expect(await setPassword(good)).toEqual({ ok: false, error: "unauthenticated" });
    expect(updateUser).not.toHaveBeenCalled();
  });
  it("refuses the demo account", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "demo" } } });
    isDemoRow.mockResolvedValue({ data: { is_demo: true }, error: null });
    expect(await setPassword(good)).toEqual({ ok: false, error: "failed" });
    expect(updateUser).not.toHaveBeenCalled();
  });
  it("fails closed when the demo flag cannot be read", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "u1" } } });
    isDemoRow.mockResolvedValue({ data: null, error: { message: "db down" } });
    expect(await setPassword(good)).toEqual({ ok: false, error: "failed" });
    isDemoRow.mockResolvedValue({ data: null, error: null });
    expect(await setPassword(good)).toEqual({ ok: false, error: "failed" });
    expect(updateUser).not.toHaveBeenCalled();
  });
  it("maps Supabase errors: reauthentication, same password, weak password", async () => {
    signedIn();
    updateUser.mockResolvedValueOnce({ error: { status: 422, code: "reauthentication_needed", message: "x" } });
    expect(await setPassword(good)).toEqual({ ok: false, error: "reauth_required" });
    updateUser.mockResolvedValueOnce({ error: { status: 422, code: "same_password", message: "x" } });
    expect(await setPassword(good)).toEqual({ ok: false, error: "same_password" });
    updateUser.mockResolvedValueOnce({ error: { status: 422, code: "weak_password", message: "x" } });
    expect(await setPassword(good)).toEqual({ ok: false, error: "weak_password" });
    updateUser.mockResolvedValueOnce({ error: { status: 500, code: "unexpected_failure", message: "x" } });
    expect(await setPassword(good)).toEqual({ ok: false, error: "failed" });
  });
});
