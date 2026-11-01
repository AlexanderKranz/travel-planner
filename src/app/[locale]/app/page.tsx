import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link, redirect } from "@/i18n/navigation";
import { TripCard } from "@/components/trips/trip-card";
import { SideList } from "@/components/dashboard/side-list";
import { btnPrimary, btnSecondary, cardCls, linkCls, mutedCls } from "@/components/ui/styles";
import { MAX_TRIPS_PER_USER } from "@/lib/domain/trip";
import { shouldShowOnboarding } from "@/lib/onboarding";
import { listGroups } from "@/lib/server/groups";
import { getProfile } from "@/lib/server/profile";
import { listPurposes } from "@/lib/server/purposes";
import { listTrips } from "@/lib/server/trips";
import { unwrap } from "@/lib/unwrap";

export default async function DashboardPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, tg, tp, ts] = await Promise.all([
    getTranslations("trips"),
    getTranslations("groups"),
    getTranslations("purposes"),
    getTranslations("start"),
  ]);
  const [profileRes, tripsRes, groupsRes, purposesRes] = await Promise.all([
    getProfile(),
    listTrips(),
    listGroups(),
    listPurposes(),
  ]);
  const profile = unwrap(profileRes, locale);
  // First visit after login: show the getting-started guide once (never for the demo account).
  if (shouldShowOnboarding(profile)) redirect({ href: "/app/start", locale });
  const trips = unwrap(tripsRes, locale);
  const groups = unwrap(groupsRes, locale);
  const purposes = unwrap(purposesRes, locale);

  return (
    <main className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
        <div className="flex flex-wrap gap-2">
          <Link href="/app/trips/discover" className={btnSecondary}>
            {t("discoverLink")}
          </Link>
          <Link href="/app/trips/new" className={btnPrimary}>
            {t("new")}
          </Link>
        </div>
      </div>
      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-label={t("title")} className="flex flex-col gap-3">
          <p className={`text-sm ${mutedCls}`}>{t("retention", { max: MAX_TRIPS_PER_USER })}</p>
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
        </section>
        <div className="flex flex-col gap-4">
          <SideList
            id="side-groups"
            title={tg("title")}
            items={groups.map(({ id, name }) => ({ id, name }))}
            itemHref="/app/groups"
            addHref="/app/groups/new"
            addLabel={tg("new")}
            allHref="/app/groups"
            emptyText={tg("empty")}
          />
          <SideList
            id="side-purposes"
            title={tp("title")}
            items={purposes.map(({ id, name }) => ({ id, name }))}
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
