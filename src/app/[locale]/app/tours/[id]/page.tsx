import { getTranslations, setRequestLocale } from "next-intl/server";
import { tourTitle } from "@/components/tour/format";
import { TourEditor } from "@/components/tour/tour-editor";
import { TourResultView } from "@/components/tour/tour-result";
import { cardCls, mutedCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import type { Tour } from "@/lib/domain/tour";
import { getTrip, listTrips } from "@/lib/server/trips";
import { tourMapStyleUrl } from "@/lib/server/tour/map-style";
import { getTour } from "@/lib/server/tours";
import { resultFitsInput } from "@/lib/tour/ui";
import { tourView } from "@/lib/tour/view";
import { unwrap } from "@/lib/unwrap";

export default async function TourPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const tour = unwrap(await getTour(id), locale);
  // A result saved before the input changed: its times and limit check would mix old legs with new dwell values.
  const view = tour.outdated ? { stopTimes: null, byMin: null } : tourView(tour.input, tour.result);
  const mapStyleUrl = tourMapStyleUrl();

  if (tour.access !== "owner") return <ReadOnlyTour tour={tour} view={view} mapStyleUrl={mapStyleUrl} />;

  const trips = await listTrips();
  const tripOptions = trips.ok ? trips.data.map((x) => ({ id: x.id, title: x.title ?? x.destination.name, lengthDays: x.lengthDays })) : [];
  return (
    <main className="flex flex-col gap-4">
      <TourEditor tour={tour} view={view} prefill={null} mapStyleUrl={mapStyleUrl} trips={tripOptions} />
    </main>
  );
}

/** A grantee of the linked trip (spec 9.3): the stored snapshot, no edit or compute controls. */
async function ReadOnlyTour({ tour, view, mapStyleUrl }: { tour: Tour; view: ReturnType<typeof tourView>; mapStyleUrl: string | null }) {
  const t = await getTranslations("tours");
  const trip = tour.tripId ? await getTrip(tour.tripId) : null;
  const tripTitle = trip?.ok ? (trip.data.title ?? trip.data.destination.name) : null;
  const title = tourTitle(t, tour.title, tour.input.city?.name ?? null, tour.input.places.length);
  return (
    <main className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        {tour.tripId && (
          <Link href={`/app/trips/${tour.tripId}`} className="inline-flex min-h-11 items-center self-start text-sm underline underline-offset-2">
            {tripTitle ? (tour.tripDay ? t("linkedTo", { trip: tripTitle, day: tour.tripDay }) : t("linkedNoDay", { trip: tripTitle })) : t("backToTrip")}
          </Link>
        )}
        <h1 className="break-words text-3xl font-bold sm:text-4xl">{title}</h1>
        <p className={`text-sm ${mutedCls}`} data-testid="tour-read-only">
          {t("readOnly")}
        </p>
      </div>
      {tour.result && resultFitsInput(tour.input, tour.result) ? (
        <TourResultView
          input={tour.input}
          result={tour.result}
          stopTimes={view.stopTimes}
          byMin={view.byMin}
          mapStyleUrl={mapStyleUrl}
          outdated={tour.outdated}
        />
      ) : (
        <div className={`${cardCls} flex flex-col gap-2`}>
          <p className={mutedCls}>{t("notComputed")}</p>
          <ol className="list-decimal pl-6">
            {tour.input.places.map((p) => (
              <li key={p.key} className="break-words">
                {p.name}
              </li>
            ))}
          </ol>
        </div>
      )}
    </main>
  );
}
