import { useTranslations } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { use } from "react";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

export default function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = use(params);
  setRequestLocale(locale);
  const t = useTranslations("home");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-4 py-12">
      <p className="font-mono text-xs uppercase tracking-widest opacity-60">
        {t("status")}
      </p>
      <h1 className="text-4xl font-bold sm:text-5xl">{t("title")}</h1>
      <p className="text-lg opacity-80">{t("tagline")}</p>
      <nav className="flex gap-3 text-sm">
        {routing.locales.map((l) => (
          <Link
            key={l}
            href="/"
            locale={l}
            className={l === locale ? "font-semibold underline" : "opacity-60"}
          >
            {l.toUpperCase()}
          </Link>
        ))}
      </nav>
    </main>
  );
}
