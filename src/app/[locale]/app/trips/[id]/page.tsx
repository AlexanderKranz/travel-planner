import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FactSkeleton } from "@/components/facts/fact-skeleton";
import { cardCls } from "@/components/ui/styles";
import { ageDateFor, berlinToday } from "@/components/trips/age-date";
import { TripContext, type ContextGroup } from "@/components/trips/trip-context";
import { TripHeader } from "@/components/trips/trip-header";
import { Link } from "@/i18n/navigation";
import { Locale, type FactsCtx } from "@/lib/domain";
import { resolveGroupAges } from "@/lib/group";
import { getGroup } from "@/lib/server/groups";
import { getProfile } from "@/lib/server/profile";
import { getPurpose } from "@/lib/server/purposes";
import { getUserSession } from "@/lib/server/session";
import { getTrip } from "@/lib/server/trips";
import { unwrap } from "@/lib/unwrap";
import { CountryPanel } from "./_panels/country-panel";
import { DaylightPanel } from "./_panels/daylight-panel";
import { PlacesPanel } from "./_panels/places-panel";
import { SummaryPanel } from "./_panels/summary-panel";
import { WeatherPanel } from "./_panels/weather-panel";

// Facts panels stream in; Overpass can be slow.
export const maxDuration = 60;

function PanelFallback({ title }: { title: string }) {
  return (
    <section aria-label={title} className={cardCls}>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      <FactSkeleton />
    </section>
  );
}

export default async function TripDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("facts");
  const trip = unwrap(await getTrip(id), locale);

  const [groupRes, purposeRes, profileRes, session] = await Promise.all([
    trip.groupId ? getGroup(trip.groupId) : null,
    trip.purposeId ? getPurpose(trip.purposeId) : null,
    getProfile(),
    getUserSession(),
  ]);
  const profile = unwrap(profileRes, locale);
  const today = berlinToday();
  const ageDate = ageDateFor(trip.timing, today);
  // A group or purpose that vanished (race) simply shows as "none".
  const group: ContextGroup | null =
    groupRes?.ok
      ? {
          id: groupRes.data.id,
          name: groupRes.data.name,
          ages: resolveGroupAges(groupRes.data.entries, ageDate, profile.birthdate),
        }
      : null;
  const purpose = purposeRes?.ok ? purposeRes.data : null;

  const ctx: FactsCtx = {
    userId: session?.userId ?? null,
    locale: Locale.catch("de").parse(locale),
    today,
  };
  const panel = { trip, purpose, ctx };

  return (
    <main className="flex flex-col gap-6">
      <TripHeader trip={trip} />
      <TripContext
        trip={trip}
        group={group}
        ageDate={ageDate}
        purpose={purpose}
        profileAirports={profile.homeAirports}
      />
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold">{t("title")}</h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{t("intro")}</p>
        <p className="text-sm">
          <Link href="/sources" className="underline underline-offset-2">
            {t("sourcesLink")}
          </Link>
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Suspense fallback={<PanelFallback title={t("weather.title")} />}>
          <WeatherPanel {...panel} />
        </Suspense>
        <Suspense fallback={<PanelFallback title={t("daylight.title")} />}>
          <DaylightPanel {...panel} />
        </Suspense>
        <Suspense fallback={<PanelFallback title={t("country.title")} />}>
          <CountryPanel {...panel} />
        </Suspense>
        <Suspense fallback={<PanelFallback title={t("summary.title")} />}>
          <SummaryPanel {...panel} />
        </Suspense>
        <div className="lg:col-span-2">
          <Suspense fallback={<PanelFallback title={t("places.title")} />}>
            <PlacesPanel {...panel} />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
