import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FactSkeleton } from "@/components/facts/fact-skeleton";
import { cardCls, linkCls } from "@/components/ui/styles";
import { ItemsSection } from "@/components/items/items-section";
import { SharePanel } from "@/components/share/share-panel";
import { PlanSection } from "@/components/plan/plan-section";
import { TripContext, type ContextGroup } from "@/components/trips/trip-context";
import { TripHeader } from "@/components/trips/trip-header";
import { TripHeroPills } from "@/components/trips/trip-hero-pills";
import { Link } from "@/i18n/navigation";
import { berlinToday } from "@/lib/date";
import { Locale, type FactsCtx } from "@/lib/domain";
import { ageReferenceDate } from "@/lib/facts/trip-timing";
import { groupPartySize, resolveGroup, tripGroupSource } from "@/lib/group-text";
import { getGroup } from "@/lib/server/groups";
import { getProfile } from "@/lib/server/profile";
import { getPurpose } from "@/lib/server/purposes";
import { getPlanState } from "@/lib/server/plans";
import { getUserSession } from "@/lib/server/session";
import { getTrip } from "@/lib/server/trips";
import { unwrap } from "@/lib/unwrap";
import { adultsFromEntries } from "@/lib/flights/ui";
import { FlightsPanelSection } from "./_panels/flights-panel";
import { GlancePanel, glanceAsideCls } from "./_panels/glance-panel";
import { PicturePanel } from "./_panels/picture-panel";
import { PlacesPanel } from "./_panels/places-panel";
import { SummaryFallback, SummaryPanel } from "./_panels/summary-panel";

// Vercel Hobby with Fluid compute allows 300 s; the after() warm-up can take minutes on Overpass.
export const maxDuration = 300;

function PanelFallback({ title, className }: { title: string; className?: string }) {
  return (
    <section aria-label={title} className={`${className ?? cardCls} min-w-0`}>
      <h2 className="mb-3 text-lg font-bold">{title}</h2>
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
  // A group or purpose that vanished (race) simply shows as "none". One resolution (saved entries > Haiku parse >
  // text only) feeds the strip, the party size and the flight passengers.
  const source = groupRes?.ok
    ? { ...groupRes.data, parse: groupRes.data.parse ?? null }
    : trip.groupId
      ? null
      : tripGroupSource(trip);
  const resolved = source ? resolveGroup(source, ageDate, profile.birthdate) : null;
  const group: ContextGroup | null = resolved
    ? {
        id: groupRes?.ok ? groupRes.data.id : undefined,
        name: groupRes?.ok ? groupRes.data.name : undefined,
        text: source?.description,
        resolved,
      }
    : null;
  const purpose = purposeRes?.ok ? purposeRes.data : null;

  const partySize = groupPartySize(resolved);
  const startDate = trip.timing.kind === "date" ? trip.timing.startDate : null;
  const planRes = await getPlanState(trip.id);
  const hasPlan = planRes.ok && planRes.data.versions.length > 0;

  const ctx: FactsCtx = {
    userId: session?.userId ?? null,
    locale: Locale.catch("de").parse(locale),
    today,
  };
  const panel = { trip, purpose, ctx };

  return (
    <main data-wide className="flex flex-col gap-8">
      {/* Nothing while loading: a reserved band would jump away when there is no picture. */}
      <Suspense fallback={null}>
        <PicturePanel trip={trip} ctx={ctx} />
      </Suspense>
      <TripHeader
        trip={trip}
        purposeName={purpose?.name ?? null}
        pills={<TripHeroPills trip={trip} group={group} />}
        aside={
          <Suspense
            fallback={
              <SummaryFallback title={t("summary.title")}>
                <FactSkeleton />
              </SummaryFallback>
            }
          >
            <SummaryPanel {...panel} />
          </Suspense>
        }
      />
      {/* Fact tiles right under the hero: climate, daylight, country (cached facts, fast). */}
      <Suspense fallback={<PanelFallback title={t("glance.title")} className={glanceAsideCls} />}>
        <GlancePanel {...panel} home={{ name: profile.homeLocation, timezone: profile.homeTimezone }} />
      </Suspense>
      <PlanSection tripId={trip.id} locale={locale} lengthDays={trip.lengthDays} version={version} partySize={partySize} startDate={startDate} />
      <TripContext
        trip={trip}
        group={group}
        ageDate={ageDate}
        purpose={purpose}
        profileAirports={profile.homeAirports}
      />
      {/* Same 2/3 + 1/3 split as the plan at lg; stacked on phones. */}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)] lg:items-start lg:gap-x-8">
        <ItemsSection tripId={trip.id} lengthDays={trip.lengthDays} startDate={startDate} partySize={partySize} />
        <SharePanel tripId={trip.id} hasPlan={hasPlan} isDemo={profile.isDemo} />
      </div>
      <p className="text-sm text-muted">
        {t("intro")}{" "}
        <Link href="/sources" className={linkCls}>
          {t("sourcesLink")}
        </Link>
      </p>
      <div className="flex min-w-0 flex-col gap-8">
        {trip.wantsFlights && (
          <div className="min-w-0">
            <FlightsPanelSection {...panel} adults={adultsFromEntries(group?.resolved.rows)} />
          </div>
        )}
        <div className="min-w-0">
          <Suspense fallback={<PanelFallback title={t("places.title")} />}>
            <PlacesPanel {...panel} />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
