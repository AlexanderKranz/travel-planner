"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LoginRequest, VerifyCodeInput } from "@/lib/domain/auth";
import { Locale } from "@/lib/domain/profile";
import { fail, type ActionResult } from "@/lib/domain/result";
import { zodIssues } from "@/lib/domain/result";
import { logEvent } from "@/lib/server/events";
import { createSupabaseServerClient } from "@/lib/server/supabase/server";

/**
 * Own origin from the request headers. Supabase only honours redirect URLs on its allow list
 * (Dashboard -> URL Configuration), so a spoofed Host cannot redirect the link elsewhere.
 */
async function requestOrigin(): Promise<string | null> {
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (!host) return null;
    const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
    return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
  } catch {
    return null;
  }
}

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

  const origin = await requestOrigin();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      shouldCreateUser: true,
      // The locale travels in the link itself (the email template uses {{ .RedirectTo }}), because
      // user metadata is ignored for EXISTING users. Without an origin the template link would break,
      // so the redirect URL is always set when the origin is known.
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
    await logEvent({ event: "auth.rate_limited", level: "warn", route: "action:requestLogin" });
    return fail("failed");
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

/** Signs out and redirects to /[locale]/login. */
export async function signOut(locale: string): Promise<void> {
  const safeLocale = Locale.catch("de").parse(locale);
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect(`/${safeLocale}/login`);
}
