import { NextResponse, type NextRequest } from "next/server";
import { ConfirmCodeQuery, ConfirmQuery, safeNextPath } from "@/lib/domain/auth";
import { Locale } from "@/lib/domain/profile";
import { routing } from "@/i18n/routing";
import { logEvent } from "@/lib/server/events";
import { createSupabaseServerClient } from "@/lib/server/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Magic-link landing. Two link shapes:
 * - our template (token-hash flow, works on any device/browser):
 *   /auth/confirm?token_hash=...&type=email&locale=de[&next=/de/app]
 *   Opening such a link NEVER spends the one-time token: mail scanners, click trackers (Brevo) and redirectors
 *   (web.de's ui-deref.de) open links before the user does, and a verify on GET would burn the token before the
 *   user's own request. So GET only redirects to the confirmation page /<locale>/login/confirm (one button).
 *   The button POSTs the same fields back to this route; only that POST calls verifyOtp, after re-validating
 *   the fields with Zod. A failed verify goes to /<locale>/login?error=link_invalid.
 * - password reset uses `type=recovery`; it always lands on /<locale>/settings?focus=password
 * - invites use the same shape with `type=invite` (custom "Invite user" template, same token-hash link)
 * - Supabase's default template, used until custom SMTP allows editing templates (PKCE flow,
 *   same browser only): Supabase verifies and redirects to /auth/confirm?locale=de&code=... (verified already,
 *   so the GET just exchanges the code)
 */
export async function GET(request: NextRequest) {
  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = ConfirmQuery.safeParse(params);
  const codeParsed = ConfirmCodeQuery.safeParse(params);
  // Parsed on its own so a bad token still sends the user to the login page in their language.
  const localeParsed = Locale.safeParse(params.locale);
  const locale = localeParsed.success ? localeParsed.data : routing.defaultLocale;

  if (parsed.success) {
    // Token-hash link: do not verify on GET (see above). Hand the fields to the confirmation page.
    const url = request.nextUrl.clone();
    url.pathname = `/${locale}/login/confirm`;
    const search = new URLSearchParams({ token_hash: parsed.data.token_hash, type: parsed.data.type });
    if (parsed.data.next) search.set("next", parsed.data.next);
    url.search = `?${search}`;
    const res = NextResponse.redirect(url);
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  }

  if (!codeParsed.success) {
    // Invite mail sent with Supabase's default template: Supabase has already verified the invite and
    // redirected here with the session in the URL fragment, which a server route cannot read. The account is
    // confirmed now, so just ask for a normal sign-in link on the login page (friendly hint, no error).
    if (params.invited === "1") {
      const url = request.nextUrl.clone();
      url.pathname = `/${locale}/login`;
      url.search = "?invited=1";
      return NextResponse.redirect(url);
    }
    return failRedirect(request, locale, "bad_query");
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(codeParsed.data.code);
  if (error || !data.user) return failRedirect(request, locale, error?.code ?? "verify_failed", 307);

  await logEvent({ event: "auth.login", userId: data.user.id, route: "/auth/confirm", props: { method: "link_code" } });
  return successRedirect(request, locale, codeParsed.data.next, false, 307);
}

/** The confirmation button: the only place a token hash is verified. Plain form POST, works without JS. */
export async function POST(request: NextRequest) {
  const form = await request.formData().catch(() => null);
  const fields: Record<string, string> = {};
  if (form) for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
  const localeParsed = Locale.safeParse(fields.locale);
  const locale = localeParsed.success ? localeParsed.data : routing.defaultLocale;

  // Browsers always send Origin on cross-site form POSTs; refuse those (no cross-site sign-in).
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) return failRedirect(request, locale, "bad_origin");

  const parsed = ConfirmQuery.safeParse(fields);
  if (!parsed.success) return failRedirect(request, locale, "bad_query");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({
    type: parsed.data.type, // "magiclink"/"signup" are legacy names for the email OTP
    token_hash: parsed.data.token_hash,
  });
  if (error || !data.user) return failRedirect(request, locale, error?.code ?? "verify_failed");

  const recovery = parsed.data.type === "recovery";
  await logEvent({
    event: "auth.login",
    userId: data.user.id,
    route: "/auth/confirm",
    props: { method: recovery ? "recovery" : "link" },
  });
  return successRedirect(request, locale, parsed.data.next, recovery);
}

// Never log the token; only a reason code.
async function failRedirect(request: NextRequest, locale: string, reason: string, status = 303) {
  await logEvent({
    event: "auth.login_failed",
    level: "warn",
    route: "/auth/confirm",
    props: { method: "link", reason },
  });
  const url = request.nextUrl.clone();
  url.pathname = `/${locale}/login`;
  url.search = "?error=link_invalid";
  return NextResponse.redirect(url, status);
}

function successRedirect(
  request: NextRequest,
  locale: string,
  next: string | undefined,
  recovery: boolean,
  status = 303,
) {
  // A recovery link exists to set a new password: it always lands there, whatever `next` says.
  const target = recovery ? `/${locale}/settings?focus=password` : safeNextPath(next, `/${locale}/app`);
  const url = request.nextUrl.clone();
  url.pathname = target.split("?")[0];
  url.search = target.includes("?") ? `?${target.split("?").slice(1).join("?")}` : "";
  return NextResponse.redirect(url, status);
}
