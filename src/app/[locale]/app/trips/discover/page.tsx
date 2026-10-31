import { getTranslations, setRequestLocale } from "next-intl/server";
import { DiscoverForm } from "@/components/discover/discover-form";
import { defaultLimitHours } from "@/components/discover/helpers";
import { linkCls, mutedCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import { maxBlockMinutes } from "@/lib/flights/constraint";
import { listGroups } from "@/lib/server/groups";
import { getProfile } from "@/lib/server/profile";
import { listPurposes } from "@/lib/server/purposes";
import { unwrap } from "@/lib/unwrap";

export default async function DiscoverPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("discover");
  const tt = await getTranslations("trips");
  const [groups, purposes, profile] = await Promise.all([listGroups(), listPurposes(), getProfile()]);
  return (
    <main className="flex max-w-3xl flex-col gap-4">
      <Link href="/app/trips" className={`${linkCls} inline-flex min-h-11 items-center self-start text-sm`}>
        {tt("back")}
      </Link>
      <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
      <p className={mutedCls}>{t("intro")}</p>
      <DiscoverForm
        purposes={unwrap(purposes, locale).map((p) => ({ id: p.id, name: p.name, maxFlightHours: defaultLimitHours(maxBlockMinutes(p)) }))}
        groups={unwrap(groups, locale).map(({ id, name }) => ({ id, name }))}
        homeAirports={unwrap(profile, locale).homeAirports}
      />
    </main>
  );
}
