import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { btnPrimary, focusCls } from "@/components/ui/styles";
import { getUserSession } from "@/lib/server/session";

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("home");
  const session = await getUserSession();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-4 py-12">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent-text">
        {t("status")}
      </p>
      <h1 className="text-5xl font-bold leading-none sm:text-7xl">{t("title")}</h1>
      <p className="font-serif text-xl leading-relaxed text-muted sm:text-2xl">{t("tagline")}</p>
      <div>
        <Link href={session ? "/app" : "/login"} className={btnPrimary}>
          {session ? t("openApp") : t("signIn")}
        </Link>
      </div>
      <nav aria-label={t("languages")} className="flex gap-1 text-sm">
        {routing.locales.map((l) => (
          <Link
            key={l}
            href="/"
            locale={l}
            aria-current={l === locale ? "true" : undefined}
            className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-md ${focusCls} ${
              l === locale ? "font-semibold text-heading underline" : "text-muted"
            }`}
          >
            {l.toUpperCase()}
          </Link>
        ))}
      </nav>
    </main>
  );
}
