import type { ReactNode } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PdfButton } from "@/components/pdf/pdf-button";
import { TourSharePanel } from "@/components/share/tour-share-panel";
import { SharedHeader } from "@/components/sharing/shared-header";
import { tourTitle } from "@/components/tour/format";
import { TourEditor } from "@/components/tour/tour-editor";
import { TourResultView } from "@/components/tour/tour-result";
import { cardCls, mutedCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import type { Tour } from "@/lib/domain/tour";
import { getProfile } from "@/lib/server/profile";
import { listSharedWithMe } from "@/lib/server/sharing";
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

  // A tour shared with the viewer directly (city-tour 9.3): who shared it, the level, and "Leave".
  const share =
    tour.access === "owner"
      ? null
      : await listSharedWithMe().then((r) => (r.ok ? (r.data.find((s) => s.resource === "tour" && s.resourceId === tour.id) ?? null) : null));
  const header = share ? <SharedHeader resource="tour" owner={share.owner} access={share.access} shareId={share.id} /> : null;

  if (tour.access === "read") return <ReadOnlyTour tour={tour} view={view} mapStyleUrl={mapStyleUrl} header={header} />;

  // Owner and write grantee edit and compute; trip link, delete and sharing stay the owner's.
  const [trips, profile] = await Promise.all([tour.access === "owner" ? listTrips() : null, getProfile()]);
  const tripOptions = trips?.ok ? trips.data.map((x) => ({ id: x.id, title: x.title ?? x.destination.name, lengthDays: x.lengthDays })) : [];
  return (
    <main className="flex flex-col gap-4">
      {header}
      <TourEditor tour={tour} view={view} prefill={null} mapStyleUrl={mapStyleUrl} trips={tripOptions} />
      {tour.result && <TourPdfBox tourId={tour.id} />}
      {tour.access === "owner" && profile.ok && (
        <TourSharePanel tourId={tour.id} computed={tour.result !== null} isDemo={profile.data.isDemo} isAdmin={profile.data.role === "admin"} />
      )}
    </main>
  );
}

/** A read grantee (of the tour or of its linked trip, spec 9.3): the stored snapshot, no edit or compute controls. */
async function ReadOnlyTour({
  tour,
  view,
  mapStyleUrl,
  header,
}: {
  tour: Tour;
  view: ReturnType<typeof tourView>;
  mapStyleUrl: string | null;
  header: ReactNode;
}) {
  const t = await getTranslations("tours");
  const trip = tour.tripId ? await getTrip(tour.tripId) : null;
  const tripTitle = trip?.ok ? (trip.data.title ?? trip.data.destination.name) : null;
  const title = tourTitle(t, tour.title, tour.input.city?.name ?? null, tour.input.places[0]?.name ?? null);
  return (
    <main className="flex flex-col gap-4">
      {header}
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
      {tour.result && <TourPdfBox tourId={tour.id} />}
      {tour.result && resultFitsInput(tour.input, tour.result) ? (
        <TourResultView
          input={tour.input}
          result={tour.result}
          stopTimes={view.stopTimes}
          byMin={view.byMin}
          mapStyleUrl={mapStyleUrl}
          outdated={tour.outdated}
          tourId={tour.id}
          title={title}
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

/** PDF of the tour for every reader (city-tour 9.3), with the opt-in "Ortsinfos aufnehmen" (city-tour-stop-info 6). */
async function TourPdfBox({ tourId }: { tourId: string }) {
  const t = await getTranslations("share");
  const tStop = await getTranslations("tours.stopInfo");
  return (
    <div className="flex flex-col gap-1" data-testid="tour-pdf">
      <PdfButton
        href={`/api/tours/${tourId}/pdf`}
        label={t("pdf")}
        busyLabel={t("pdfBusy")}
        errorText={t("pdfFailed")}
        stopInfoLabel={tStop("pdfInclude")}
      />
    </div>
  );
}
