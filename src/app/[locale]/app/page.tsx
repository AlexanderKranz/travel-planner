import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { btnPrimary, cardCls, mutedCls } from "@/components/ui/styles";
import { getProfile } from "@/lib/server/profile";
import { unwrap } from "@/lib/unwrap";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("dashboard");
  const profile = unwrap(await getProfile(), locale);

  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">
        {profile.displayName ? t("welcomeNamed", { name: profile.displayName }) : t("welcome")}
      </h1>
      <section className={cardCls} aria-labelledby="trips-title">
        <h2 id="trips-title" className="font-semibold">
          {t("tripsTitle")}
        </h2>
        <p className={`${mutedCls} mb-3`}>{t("tripsPlaceholder")}</p>
        <Link href="/app/trips" className={btnPrimary}>
          {t("tripsOpen")}
        </Link>
      </section>
    </main>
  );
}
