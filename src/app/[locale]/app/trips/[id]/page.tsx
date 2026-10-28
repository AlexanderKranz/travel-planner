import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FactSkeleton } from "@/components/facts/fact-skeleton";
import { cardCls } from "@/components/ui/styles";
import { PlanSection } from "@/components/plan/plan-section";
import { TripContext, type ContextGroup } from "@/components/trips/trip-context";
import { TripHeader } from "@/components/trips/trip-header";
import { Link } from "@/i18n/navigation";
import { berlinToday } from "@/lib/date";
import { Locale, type FactsCtx } from "@/lib/domain";
import { ageReferenceDate } from "@/lib/facts/trip-timing";
import { resolveGroupAges } from "@/lib/group";
import { getGroup } from "@/lib/server/groups";
import { getProfile } from "@/lib/server/profile";
import { getPurpose } from "@/lib/server/purposes";
import { getUserSession } from "@/lib/server/session";
import { getTrip } from "@/lib/server/trips";
import { unwrap } from "@/lib/unwrap";
import { GlancePanel, glanceAsideCls } from "./_panels/glance-panel";
import { PlacesPanel } from "./_panels/places-panel";
import { SummaryPanel } from "./_panels/summary-panel";

// Vercel Hobby with Fluid compute allows 300 s; the after() warm-up can take minutes on Overpass.
export const maxDuration = 300;

function PanelFallback({ title, className }: { title: string; className?: string }) {
  return (
    <section aria-label={title} className={`${className ?? cardCls} min-w-0`}>
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      <FactSkeleton />
    </section>
  );
}

export default async function TripDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ v?: string | string[] }>;
}) {
  const { locale, id } = await params;
  const { v } = await searchParams;
  const versionNo = Number(Array.isArray(v) ? v[0] : v);
  const version = Number.isInteger(versionNo) && versionNo > 0 ? versionNo : undefined;
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
  const ageDate = ageReferenceDate(trip, today) ?? today;
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
      <PlanSection tripId={trip.id} locale={locale} lengthDays={trip.lengthDays} version={version} />
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {t("intro")}{" "}
        <Link href="/sources" className="underline underline-offset-2">
          {t("sourcesLink")}
        </Link>
      </p>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-x-8">
        <Suspense
          fallback={
            <PanelFallback
              title={t("summary.title")}
              className="order-1 lg:col-start-1 lg:row-start-1"
            />
          }
        >
          <SummaryPanel {...panel} />
        </Suspense>
        <Suspense fallback={<PanelFallback title={t("glance.title")} className={glanceAsideCls} />}>
          <GlancePanel {...panel} />
        </Suspense>
        <div className="order-3 min-w-0 lg:col-span-2">
          <Suspense fallback={<PanelFallback title={t("places.title")} />}>
            <PlacesPanel {...panel} />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
