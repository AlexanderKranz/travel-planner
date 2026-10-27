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
      <p className="font-mono text-xs uppercase tracking-widest opacity-60">
        {t("status")}
      </p>
      <h1 className="text-4xl font-bold sm:text-5xl">{t("title")}</h1>
      <p className="text-lg opacity-80">{t("tagline")}</p>
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
              l === locale ? "font-semibold underline" : "opacity-70"
            }`}
          >
            {l.toUpperCase()}
          </Link>
        ))}
      </nav>
    </main>
  );
}
