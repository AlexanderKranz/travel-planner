"use server";

import { redirect } from "next/navigation";
import { LoginRequest, PasswordLoginInput, SetPasswordInput, VerifyCodeInput } from "@/lib/domain/auth";
import { getUserSession } from "@/lib/server/session";
import { Locale } from "@/lib/domain/profile";
import { fail, type ActionResult } from "@/lib/domain/result";
import { zodIssues } from "@/lib/domain/result";
import { getAppUrl } from "@/lib/server/app-url";
import { getDemoCredentials } from "@/lib/server/demo";
import { logEvent } from "@/lib/server/events";
import { createSupabaseServerClient } from "@/lib/server/supabase/server";
import { authAllowed } from "./limits";
import { getEffectiveEnv } from "@/lib/server/settings";

/**
 * Sends the magic link + 6-digit code. The result is deliberately the same for
 * invited and non-invited addresses (the Before User Created hook rejects the
 * latter with 403), so the UI can always show the neutral message
 * "If this address is invited, a link is on its way".
 */
export async function requestLogin(input: {
  email: string;
  locale: string;
}): Promise<ActionResult> {
  const parsed = LoginRequest.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  if (!(await authAllowed("login", parsed.data.email))) return fail("rate_limited");

  // Configured base URL, never request headers (Host / X-Forwarded-Host are attacker-controlled).
  const origin = getAppUrl();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      shouldCreateUser: true,
      // The locale travels in the link itself (the email template uses {{ .RedirectTo }}), because
      // user metadata is ignored for EXISTING users. If no base URL is configured the
      // redirect is omitted and Supabase falls back to its Site URL.
      ...(origin ? { emailRedirectTo: `${origin}/auth/confirm?locale=${parsed.data.locale}` } : {}),
      // New users only: read by the signup trigger for the profile locale.
      data: { locale: parsed.data.locale },
    },
  });

  if (!error) {
    await logEvent({ event: "auth.login_requested", route: "action:requestLogin" });
    return { ok: true };
  }
  if (error.status === 403 || error.message.includes("signup_not_allowed")) {
    await logEvent({ event: "auth.signup_rejected", level: "warn", route: "action:requestLogin" });
    return { ok: true }; // neutral on purpose
  }
  if (error.status === 429) {
    // Neutral on purpose: Supabase's per-address limit would otherwise reveal that mail was sent to this address.
    await logEvent({ event: "auth.rate_limited", level: "warn", route: "action:requestLogin" });
    return { ok: true };
  }
  await logEvent({
    event: "error.auth",
    level: "error",
    route: "action:requestLogin",
    props: { status: error.status ?? null, code: error.code ?? null },
  });
  return fail("failed");
}

/** Fallback for the installed PWA: verify the 6-digit code from the email. Redirects to /[locale]/app on success. */
export async function verifyLoginCode(input: {
  email: string;
  code: string;
  locale: string;
}): Promise<ActionResult> {
  const parsed = VerifyCodeInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  if (!(await authAllowed("code", parsed.data.email))) return fail("rate_limited");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email: parsed.data.email,
    token: parsed.data.code,
    type: "email",
  });
  if (error || !data.user) {
    await logEvent({
      event: "auth.login_failed",
      level: "warn",
      route: "action:verifyLoginCode",
      props: { method: "code", status: error?.status ?? null },
    });
    return fail("invalid");
  }
  await logEvent({
    event: "auth.login",
    userId: data.user.id,
    route: "action:verifyLoginCode",
    props: { method: "code" },
  });
  redirect(`/${parsed.data.locale}/app`);
}

/**
 * Optional password sign-in (the email link stays the default). It never creates users: invite-only is
 * unchanged because signInWithPassword only works for existing accounts. Wrong email, wrong password, an
 * account without a password and a banned account all return the same "invalid_credentials", so the
 * answer cannot reveal who has an account. Redirects to /[locale]/app on success.
 */
export async function signInWithPasswordAction(input: {
  email: string;
  password: string;
  locale: string;
}): Promise<ActionResult> {
  const parsed = PasswordLoginInput.safeParse(input);
  if (!parsed.success) return fail("invalid_credentials"); // do not hint at what was wrong
  if (!(await authAllowed("password", parsed.data.email))) return fail("rate_limited");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error || !data.user) {
    // Status only: never the email, the password or the error message.
    await logEvent({
      event: "auth.login_failed",
      level: "warn",
      route: "action:signInWithPasswordAction",
      props: { method: "password", status: error?.status ?? null },
    });
    return fail("invalid_credentials");
  }
  await logEvent({
    event: "auth.login",
    userId: data.user.id,
    route: "action:signInWithPasswordAction",
    props: { method: "password" },
  });
  redirect(`/${parsed.data.locale}/app`);
}

/**
 * "Forgot password": sends the Reset Password email. Neutral answer whether or not the address has an
 * account, shares the `login` mail rate limit. A no-op for the demo account's address, so nobody can take
 * over the shared demo password (compared against DEMO_EMAIL even if the demo is switched off).
 */
export async function requestPasswordReset(input: { email: string; locale: string }): Promise<ActionResult> {
  const parsed = LoginRequest.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  if (!(await authAllowed("login", parsed.data.email))) return fail("rate_limited");

  const env = await getEffectiveEnv();
  const demoEmail = env.DEMO_EMAIL?.trim().toLowerCase();
  if (demoEmail && parsed.data.email === demoEmail) {
    await logEvent({ event: "auth.reset_blocked_demo", level: "warn", route: "action:requestPasswordReset" });
    return { ok: true }; // neutral on purpose
  }

  // Fail closed without a base URL: the template appends `&token_hash=...` to RedirectTo, which needs the `?`
  // and `next` of our link. Supabase's Site URL fallback would break the link.
  const origin = getAppUrl();
  if (!origin) {
    await logEvent({ event: "error.auth", level: "error", route: "action:requestPasswordReset", props: { reason: "no_app_url" } });
    return fail("failed");
  }
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    // Same shape as the magic link (the template appends token_hash and type=recovery); `next` lands on Settings.
    redirectTo: `${origin}/auth/confirm?locale=${parsed.data.locale}&next=${encodeURIComponent(
      `/${parsed.data.locale}/settings?focus=password`,
    )}`,
  });
  if (!error) {
    await logEvent({ event: "auth.reset_requested", route: "action:requestPasswordReset" });
    return { ok: true };
  }
  if (error.status === 429) {
    // Neutral on purpose (see requestLogin).
    await logEvent({ event: "auth.rate_limited", level: "warn", route: "action:requestPasswordReset" });
    return { ok: true };
  }
  await logEvent({
    event: "error.auth",
    level: "error",
    route: "action:requestPasswordReset",
    props: { status: error.status ?? null, code: error.code ?? null },
  });
  return fail("failed");
}

/**
 * Sets or changes the signed-in user's password (Settings, or right after a reset link). Refused for the
 * shared demo account; fail closed if the flag cannot be read.
 */
export async function setPassword(input: { password: string; confirm: string }): Promise<ActionResult> {
  const parsed = SetPasswordInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");

  const { data: flag, error: flagError } = await session.supabase
    .from("profiles")
    .select("is_demo")
    .eq("id", session.userId)
    .maybeSingle();
  if (flagError || !flag || flag.is_demo) {
    if (flag?.is_demo) {
      await logEvent({ event: "auth.password_blocked_demo", level: "warn", userId: session.userId, route: "action:setPassword" });
    }
    return fail("failed");
  }

  const { error } = await session.supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    // With Supabase's "Secure password change" on, a session older than 24 h must re-authenticate first.
    const code = error.code ?? "";
    await logEvent({
      event: "auth.password_change_failed",
      level: "warn",
      userId: session.userId,
      route: "action:setPassword",
      props: { status: error.status ?? null, code: code || null },
    });
    if (code === "reauthentication_needed" || code === "reauthentication_not_valid") return fail("reauth_required");
    if (code === "same_password") return fail("same_password");
    if (code === "weak_password") return fail("weak_password");
    return fail("failed");
  }
  // End every other session (a stolen one included). A failure here must not report the change as failed.
  const { error: signOutError } = await session.supabase.auth.signOut({ scope: "others" });
  if (signOutError) {
    await logEvent({
      event: "auth.signout_others_failed",
      level: "warn",
      userId: session.userId,
      route: "action:setPassword",
      props: { status: signOutError.status ?? null, code: signOutError.code ?? null },
    });
  }
  await logEvent({ event: "auth.password_set", userId: session.userId, route: "action:setPassword" });
  return { ok: true };
}

/** Signs out and redirects to /[locale]/login. */
export async function signOut(locale: string): Promise<void> {
  const safeLocale = Locale.catch("de").parse(locale);
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect(`/${safeLocale}/login`);
}

/**
 * One-click login for the shared demo account. The password is read server-side only and
 * signed in on the cookie-bound client, so it never reaches the browser.
 */
export async function signInDemo(locale: string): Promise<ActionResult> {
  const creds = getDemoCredentials(await getEffectiveEnv());
  if (!creds) return fail("failed");
  const safeLocale = Locale.catch("de").parse(locale);
  if (!(await authAllowed("demo"))) return fail("rate_limited");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: creds.email,
    password: creds.password,
  });
  if (error || !data.user) {
    await logEvent({
      event: "error.demo_login",
      level: "error",
      route: "action:signInDemo",
      props: { status: error?.status ?? null, code: error?.code ?? null },
    });
    return fail("failed");
  }
  await logEvent({ event: "auth.demo_login", userId: data.user.id, route: "action:signInDemo" });
  redirect(`/${safeLocale}/app`);
}
