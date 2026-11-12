import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FactSkeleton } from "@/components/facts/fact-skeleton";
import { cardCls, linkCls } from "@/components/ui/styles";
import { ItemsSection } from "@/components/items/items-section";
import { SharePanel } from "@/components/share/share-panel";
import { birthdateForAge, personLabel } from "@/components/sharing/helpers";
import { SharedContext } from "@/components/sharing/shared-context";
import { SharedHeader } from "@/components/sharing/shared-header";
import { PlanSection } from "@/components/plan/plan-section";
import { TripHeader } from "@/components/trips/trip-header";
import { TripHeroPills, type ContextGroup } from "@/components/trips/trip-hero-pills";
import { TripStopsCount, TripStopsList } from "@/components/trips/trip-stops-list";
import { Link } from "@/i18n/navigation";
import { berlinToday } from "@/lib/date";
import { Locale, type FactsCtx } from "@/lib/domain";
import { ageReferenceDate } from "@/lib/facts/trip-timing";
import { groupPartySize, resolveGroup, tripGroupSource } from "@/lib/group-text";
import { tripPurpose } from "@/lib/purpose-source";
import { getGroupOnce, getPlanStateOnce, getProfileOnce, getPurposeOnce, getTripOnce } from "@/lib/server/request-reads";
import { loadAgeRefs } from "@/lib/server/age-refs";
import { getUserSession } from "@/lib/server/session";
import { getTripOwnerContext, listGrants, listSharedWithMe } from "@/lib/server/sharing";
import type { Person } from "@/lib/domain/sharing";
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
  const trip = unwrap(await getTripOnce(id), locale);

  const [groupRes, purposeRes, profileRes, session] = await Promise.all([
    trip.groupId ? getGroupOnce(trip.groupId) : null,
    trip.purposeId ? getPurposeOnce(trip.purposeId) : null,
    getProfileOnce(),
    getUserSession(),
  ]);
  const profile = unwrap(profileRes, locale);
  const today = berlinToday();
  const ageDate = ageReferenceDate(trip, today) ?? today;
  const isOwner = trip.access === "owner";
  // Recipient: who shared it (name for badge and "by"), the owner's age on the travel date (never the birthdate), the
  // share row for "Leave".
  let owner: Person | null = null;
  let ownerAge: number | null = null;
  let sharedOwnerBirthdate: string | null = null;
  let shareId: string | null = null;
  // The viewer's group shares: needed for a recipient of the trip, and for an own trip that uses someone else's group.
  const groupIsForeign = !!groupRes?.ok && groupRes.data.access !== "owner";
  let groupShareOwner: Person | null = null;
  if (!isOwner || groupIsForeign) {
    const [ctxRes, incoming] = await Promise.all([
      isOwner ? null : getTripOwnerContext(trip.id),
      listSharedWithMe(),
    ]);
    const mine = incoming.ok ? incoming.data.find((s) => s.resource === "trip" && s.resourceId === trip.id) : undefined;
    shareId = mine?.id ?? null;
    owner = mine?.owner ?? (ctxRes?.ok ? ctxRes.data.owner : null);
    ownerAge = ctxRes?.ok ? ctxRes.data.ownerAge : null;
    sharedOwnerBirthdate = ctxRes?.ok ? ctxRes.data.ownerBirthdate : null;
    if (groupRes?.ok) {
      groupShareOwner = incoming.ok ? (incoming.data.find((s) => s.resource === "group" && s.resourceId === groupRes.data.id)?.owner ?? null) : null;
    }
  }
  // The trip owner's birthdate: the real one when the owner's group shows it on its is_self entry (decision A). Without
  // that entry the server sends only the age, and the age stands in for "about my age" (never displayed: there is no
  // is_self row to show it on).
  const ownerBirthdate = isOwner
    ? profile.birthdate
    : (sharedOwnerBirthdate ?? (ownerAge === null ? null : birthdateForAge(ownerAge, ageDate)));
  // A group or purpose that vanished (race) simply shows as "none". One resolution (saved entries > Haiku parse >
  // text only) feeds the strip, the party size and the flight passengers.
  const source = groupRes?.ok
    ? { ...groupRes.data, parse: groupRes.data.parse ?? null }
    : trip.groupId
      ? null
      : tripGroupSource(trip);
  // The same anchors as the plan input (group-sharing 1.4): a group of someone else ages its is_self row from the group
  // owner's birthdate, "about my age" follows the trip owner's linked entry. Unreadable owner profile: null
  // (unknown ages, never the trip owner's birthdate on the group owner's row; fail closed like the pipeline).
  const refs = groupRes?.ok
    ? ((await loadAgeRefs({ tripOwnerId: trip.ownerId, tripOwnerBirthdate: ownerBirthdate, group: groupRes.data })) ?? null)
    : ownerBirthdate;
  const resolved = source ? resolveGroup(source, ageDate, refs) : null;
  const group: ContextGroup | null = resolved
    ? {
        id: groupRes?.ok ? groupRes.data.id : undefined,
        name: groupRes?.ok ? groupRes.data.name : undefined,
        text: source?.description,
        resolved,
      }
    : null;
  // The saved purpose, else the trip's one-off text (trip-purpose-text P5).
  const purpose = tripPurpose(trip, purposeRes?.ok ? purposeRes.data : null);
  // Who the group belongs to, for "(group owner)" and "about {name}'s age": the share's contact name (email as fallback),
  // else the display name the server sent, else the trip owner when they own it.
  const savedGroup = groupRes?.ok ? groupRes.data : null;
  const groupOwnerLabel = !savedGroup
    ? null
    : groupShareOwner
      ? personLabel(groupShareOwner)
      : (savedGroup.owner?.name ?? (savedGroup.ownerId === trip.ownerId && owner ? personLabel(owner) : null));

  const partySize = groupPartySize(resolved);
  const startDate = trip.timing.kind === "date" ? trip.timing.startDate : null;
  // One plan-state load per request: PlanSection asks for the same (trip, version) and gets this result. The share
  // panel only needs to know whether any version exists, so a ?v= that does not exist falls back to the latest.
  let planRes = await getPlanStateOnce(trip.id, version);
  if (!planRes.ok && version !== undefined) planRes = await getPlanStateOnce(trip.id);
  const hasPlan = planRes.ok && planRes.data.versions.length > 0;

  // Names for "by {name}" on versions written by someone else.
  const authors: Record<string, string> = {};
  const others = planRes.ok ? planRes.data.versions.filter((v) => v.createdBy && v.createdBy !== session?.userId) : [];
  if (others.length > 0) {
    if (owner) authors[trip.ownerId] = personLabel(owner);
    else {
      const grants = await listGrants("trip", trip.id);
      if (grants.ok) for (const g of grants.data) authors[g.grantee.id] = personLabel(g.grantee);
    }
  }

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
        shared={owner && trip.access !== "owner" ? <SharedHeader resource="trip" owner={owner} access={trip.access} shareId={shareId} /> : undefined}
        pills={
          <TripHeroPills
            trip={trip}
            group={group}
            stops={
              <Suspense fallback={null}>
                <TripStopsCount tripId={trip.id} />
              </Suspense>
            }
          />
        }
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
      {((!isOwner && owner) || groupIsForeign) && (
        <SharedContext
          group={group?.resolved ?? null}
          saved={groupRes?.ok ? groupRes.data : null}
          groupName={group?.name}
          purpose={isOwner ? null : purpose}
          ownerName={owner ? personLabel(owner) : ""}
          tripOwnerId={trip.ownerId}
          groupOwnerLabel={groupOwnerLabel}
          aboutOwner={typeof refs === "object" && refs?.meIs === "groupOwner" ? groupOwnerLabel : null}
          canChange={trip.access === "write"}
        />
      )}
      {/* Read-only stops of a multi-stop trip (nothing otherwise); the stop count in the hero links here. */}
      <Suspense fallback={null}>
        <TripStopsList trip={trip} />
      </Suspense>
      <PlanSection tripId={trip.id} locale={locale} lengthDays={trip.lengthDays} version={version} partySize={partySize} startDate={startDate} authors={authors} />
      {/* Same 2/3 + 1/3 split as the plan at lg; stacked on phones. */}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)] lg:items-start lg:gap-x-8">
        <ItemsSection tripId={trip.id} lengthDays={trip.lengthDays} startDate={startDate} partySize={partySize} readOnly={trip.access === "read"} />
        <SharePanel tripId={trip.id} hasPlan={hasPlan} isDemo={profile.isDemo} isAdmin={profile.role === "admin"} owner={isOwner} />
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
