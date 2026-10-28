import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { TripCard } from "@/components/trips/trip-card";
import { btnPrimary, cardCls, mutedCls } from "@/components/ui/styles";
import { MAX_TRIPS_PER_USER } from "@/lib/domain/trip";
import { listTrips } from "@/lib/server/trips";
import { unwrap } from "@/lib/unwrap";

export default async function TripsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("trips");
  const trips = unwrap(await listTrips(), locale);

  return (
    <main className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
        <Link href="/app/trips/new" className={btnPrimary}>
          {t("new")}
        </Link>
      </div>
      <p className={mutedCls}>{t("intro")}</p>
      <p className={`text-sm ${mutedCls}`}>{t("retention", { max: MAX_TRIPS_PER_USER })}</p>
      {trips.length === 0 ? (
        <div className={`${cardCls} flex flex-col gap-3`}>
          <p>{t("empty")}</p>
          <p className={`text-sm ${mutedCls}`}>{t("emptyHint")}</p>
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
    </main>
  );
}
