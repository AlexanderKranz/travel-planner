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
 * - password reset uses `type=recovery` and `next=/<locale>/settings?focus=password` (lands on the password section)
 * - invites use the same shape with `type=invite` (custom "Invite user" template, same token-hash link)
 * - Supabase's default template, used until custom SMTP allows editing templates (PKCE flow,
 *   same browser only): Supabase verifies and redirects to /auth/confirm?locale=de&code=...
 */
export async function GET(request: NextRequest) {
  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = ConfirmQuery.safeParse(params);
  const codeParsed = ConfirmCodeQuery.safeParse(params);
  // Parsed on its own so a bad token still sends the user to the login page in their language.
  const localeParsed = Locale.safeParse(params.locale);
  const locale = localeParsed.success ? localeParsed.data : routing.defaultLocale;

  const fail = async (reason: string) => {
    await logEvent({
      event: "auth.login_failed",
      level: "warn",
      route: "/auth/confirm",
      props: { method: "link", reason },
    });
    const url = request.nextUrl.clone();
    url.pathname = `/${locale}/login`;
    url.search = "?error=link_invalid";
    return NextResponse.redirect(url);
  };

  if (!parsed.success && !codeParsed.success) {
    // Invite mail sent with Supabase's default template: Supabase has already verified the invite and
    // redirected here with the session in the URL fragment, which a server route cannot read. The account is
    // confirmed now, so just ask for a normal sign-in link on the login page (friendly hint, no error).
    if (params.invited === "1") {
      const url = request.nextUrl.clone();
      url.pathname = `/${locale}/login`;
      url.search = "?invited=1";
      return NextResponse.redirect(url);
    }
    return fail("bad_query");
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = parsed.success
    ? await supabase.auth.verifyOtp({
        type: parsed.data.type, // "magiclink"/"signup" are legacy names for the email OTP
        token_hash: parsed.data.token_hash,
      })
    : await supabase.auth.exchangeCodeForSession(codeParsed.data!.code);
  if (error || !data.user) return fail(error?.code ?? "verify_failed");

  await logEvent({
    event: "auth.login",
    userId: data.user.id,
    route: "/auth/confirm",
    props: { method: parsed.success ? (parsed.data.type === "recovery" ? "recovery" : "link") : "link_code" },
  });

  const next = parsed.success ? parsed.data.next : codeParsed.data!.next;
  // A recovery link exists to set a new password: it always lands there, whatever `next` says.
  const recovery = parsed.success && parsed.data.type === "recovery";
  const target = recovery ? `/${locale}/settings?focus=password` : safeNextPath(next, `/${locale}/app`);
  const url = request.nextUrl.clone();
  url.pathname = target.split("?")[0];
  url.search = target.includes("?") ? `?${target.split("?").slice(1).join("?")}` : "";
  return NextResponse.redirect(url);
}
