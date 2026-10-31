import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { btnPrimary, linkCls, mutedCls } from "@/components/ui/styles";
import { ConfirmQuery } from "@/lib/domain/auth";

// The URL carries a one-time token: never cache, never index. Referrer-Policy and Cache-Control headers for
// this path are set in next.config.ts.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

/** Button copy key per token type ("magiclink"/"signup" are legacy names for the email link). */
const COPY = {
  email: "signin",
  magiclink: "signin",
  signup: "signin",
  recovery: "recovery",
  invite: "invite",
} as const;

/**
 * Confirmation step for emailed links. Opening the link only shows this page; the one-time token is spent
 * when the user presses the button (POST /auth/confirm), so link scanners and redirectors cannot burn it.
 */
export default async function ConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const raw = await searchParams;
  const parsed = ConfirmQuery.safeParse({
    token_hash: typeof raw.token_hash === "string" ? raw.token_hash : undefined,
    type: typeof raw.type === "string" ? raw.type : undefined,
    next: typeof raw.next === "string" ? raw.next : undefined,
  });
  if (!parsed.success) redirect(`/${locale}/login?error=link_invalid`);

  const t = await getTranslations("login.confirm");
  const tn = await getTranslations("nav");
  const kind = COPY[parsed.data.type];

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-4 py-12">
      <Link href="/" className={`self-start font-serif text-xl font-bold tracking-wide ${linkCls} no-underline`}>
        {tn("appName")}
      </Link>
      <div className="flex flex-col gap-6 rounded-[14px] border border-line bg-card p-5 sm:p-8">
        <h1 className="text-3xl font-bold sm:text-4xl">{t(`${kind}.title`)}</h1>
        <p className={mutedCls}>{t(`${kind}.body`)}</p>
        {/* Plain form POST (works without JS). The route re-validates every field. */}
        <form method="post" action="/auth/confirm" className="flex flex-col gap-3">
          <input type="hidden" name="token_hash" value={parsed.data.token_hash} />
          <input type="hidden" name="type" value={parsed.data.type} />
          <input type="hidden" name="locale" value={locale} />
          {parsed.data.next && <input type="hidden" name="next" value={parsed.data.next} />}
          <button type="submit" className={`${btnPrimary} w-full`}>
            {t(`${kind}.button`)}
          </button>
        </form>
        <p className={`text-sm ${mutedCls}`}>{t("hint")}</p>
      </div>
    </main>
  );
}
