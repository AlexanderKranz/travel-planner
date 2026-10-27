import { NextResponse, type NextRequest } from "next/server";
import { ConfirmQuery, safeNextPath } from "@/lib/domain/auth";
import { Locale } from "@/lib/domain/profile";
import { routing } from "@/i18n/routing";
import { logEvent } from "@/lib/server/events";
import { createSupabaseServerClient } from "@/lib/server/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Magic-link landing (token-hash flow, works on any device/browser):
 * /auth/confirm?token_hash=...&type=email&locale=de[&next=/de/app]
 */
export async function GET(request: NextRequest) {
  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = ConfirmQuery.safeParse(params);
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

  if (!parsed.success) return fail("bad_query");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.verifyOtp({
    type: parsed.data.type, // "magiclink"/"signup" are legacy names for the email OTP
    token_hash: parsed.data.token_hash,
  });
  if (error || !data.user) return fail(error?.code ?? "verify_failed");

  await logEvent({
    event: "auth.login",
    userId: data.user.id,
    route: "/auth/confirm",
    props: { method: "link" },
  });

  const target = safeNextPath(parsed.data.next, `/${locale}/app`);
  const url = request.nextUrl.clone();
  url.pathname = target.split("?")[0];
  url.search = target.includes("?") ? `?${target.split("?").slice(1).join("?")}` : "";
  return NextResponse.redirect(url);
}
