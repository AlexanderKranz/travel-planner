import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link, redirect } from "@/i18n/navigation";
import { TourCard } from "@/components/tour/tour-card";
import { TripCard } from "@/components/trips/trip-card";
import { personLabel } from "@/components/sharing/helpers";
import { SharedTrips } from "@/components/sharing/shared-lists";
import { SideList } from "@/components/dashboard/side-list";
import { btnPrimary, btnSecondary, cardCls, linkCls, mutedCls } from "@/components/ui/styles";
import { MAX_TRIPS_PER_USER } from "@/lib/domain/trip";
import { shouldShowOnboarding } from "@/lib/onboarding";
import { listGroups } from "@/lib/server/groups";
import { getProfile } from "@/lib/server/profile";
import { listPurposes } from "@/lib/server/purposes";
import { listSharedWithMe } from "@/lib/server/sharing";
import { listTours } from "@/lib/server/tours";
import { listTrips } from "@/lib/server/trips";
import { unwrap } from "@/lib/unwrap";

const DASHBOARD_TOURS = 5;

export default async function DashboardPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, tg, tp, ts, tt] = await Promise.all([
    getTranslations("trips"),
    getTranslations("groups"),
    getTranslations("purposes"),
    getTranslations("start"),
    getTranslations("tours"),
  ]);
  const [profileRes, tripsRes, groupsRes, purposesRes, incomingRes, toursRes] = await Promise.all([
    getProfile(),
    listTrips(),
    listGroups(),
    listPurposes(),
    listSharedWithMe(),
    listTours(),
  ]);
  const profile = unwrap(profileRes, locale);
  // First visit after login: show the getting-started guide once (never for the demo account).
  if (shouldShowOnboarding(profile)) redirect({ href: "/app/start", locale });
  const trips = unwrap(tripsRes, locale);
  const groups = unwrap(groupsRes, locale);
  const purposes = unwrap(purposesRes, locale);
  // A failed shares read must not break the own lists: the section simply stays hidden.
  const incoming = incomingRes.ok ? incomingRes.data : [];
  // City tours (spec city-tour 2.1): the section is hidden when there are none (or they cannot be read).
  const tours = toursRes.ok ? toursRes.data : [];
  const sharedPurposeItems = incoming.flatMap((s) =>
    s.resource === "purpose" && s.purpose ? [{ id: s.purpose.id, name: `${s.purpose.name} (${personLabel(s.owner)})` }] : [],
  );

  const sharedGroupItems = incoming.flatMap((s) =>
    s.resource === "group" && s.group ? [{ id: s.group.id, name: `${s.group.name} (${personLabel(s.owner)})` }] : [],
  );

  return (
    // data-wide lifts the shell's 48rem cap; the page keeps it below lg and uses the full width for three columns.
    <main data-wide className="mx-auto flex w-full max-w-3xl flex-col gap-4 lg:max-w-none">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/app/trips/discover" className={btnSecondary}>
            {t("discoverLink")}
          </Link>
          <Link href="/app/tours/new" className={btnSecondary}>
            {tt("newTour")}
          </Link>
          <Link href="/app/trips/new" className={btnPrimary}>
            {t("new")}
          </Link>
        </div>
      </div>
      {/* Phones: trips, tours, side lists stacked. md: tours below the trips, side lists on the right. lg (desktop):
          three columns, trips | city tours | groups and purposes (Alex, 2026-11-12). */}
      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1fr)_20rem] lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)_20rem]">
        <section aria-label={t("title")} className="flex flex-col gap-3 md:col-start-1 md:row-start-1">
          {trips.length === 0 ? (
            <div className={`${cardCls} flex flex-col gap-3`}>
              <p>{t("empty")}</p>
              <p className={`text-sm ${mutedCls}`}>{t("emptyHint")}</p>
              <Link href="/app/start" className={`${linkCls} inline-flex min-h-11 items-center self-start`}>
                {ts("link.trips")}
              </Link>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {trips.map((trip) => (
                <li key={trip.id}>
                  <TripCard trip={trip} />
                </li>
              ))}
            </ul>
          )}
          <SharedTrips shares={incoming} />
          {/* Below the list, so the first card lines up with the side column. */}
          <p className={`text-sm ${mutedCls}`}>{t("retention", { max: MAX_TRIPS_PER_USER })}</p>
        </section>
        {/* Hidden when empty, except as the desktop column, where an empty state keeps the layout. */}
        <section
          aria-labelledby="dashboard-tours"
          className={`${tours.length > 0 ? "flex" : "hidden lg:flex"} flex-col gap-2 md:col-start-1 md:row-start-2 lg:col-start-2 lg:row-start-1`}
        >
          <h2 id="dashboard-tours" className="text-2xl font-bold">
            {tt("title")}
          </h2>
          {tours.length === 0 ? (
            <div className={`${cardCls} flex flex-col gap-3`}>
              <p className={`text-sm ${mutedCls}`}>{tt("empty")}</p>
              <Link href="/app/tours/new" className={`${linkCls} inline-flex min-h-11 items-center self-start`}>
                {tt("newTour")}
              </Link>
            </div>
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {tours.slice(0, DASHBOARD_TOURS).map((tour) => (
                  <li key={tour.id}>
                    <TourCard tour={tour} />
                  </li>
                ))}
              </ul>
              <Link href="/app/tours" className={`${linkCls} inline-flex min-h-11 items-center self-start text-sm`}>
                {tours.length > DASHBOARD_TOURS ? t("showAll", { count: tours.length }) : tt("allTours")}
              </Link>
            </>
          )}
        </section>
        <div className="flex flex-col gap-4 md:col-start-2 md:row-span-2 md:row-start-1 lg:col-start-3 lg:row-span-1">
          <SideList
            id="side-groups"
            title={tg("title")}
            items={[...groups.map(({ id, name }) => ({ id, name })), ...sharedGroupItems]}
            itemHref="/app/groups"
            addHref="/app/groups/new"
            addLabel={tg("new")}
            allHref="/app/groups"
            emptyText={tg("empty")}
          />
          <SideList
            id="side-purposes"
            title={tp("title")}
            items={[...purposes.map(({ id, name }) => ({ id, name })), ...sharedPurposeItems]}
            itemHref="/app/purposes"
            addHref="/app/purposes/new"
            addLabel={tp("new")}
            allHref="/app/purposes"
            emptyText={tp("empty")}
          />
        </div>
      </div>
    </main>
  );
}
