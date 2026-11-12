import { setRequestLocale } from "next-intl/server";
import { TourEditor } from "@/components/tour/tour-editor";
import { tourMapStyleUrl } from "@/lib/server/tour/map-style";
import { tourPrefill } from "@/lib/server/tour/prefill";
import { listTrips } from "@/lib/server/trips";

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * New city tour. `?trip=<id>&day=<n>` (spec 2.2, "Stadttour für diesen Tag"): prefilled from that trip day by code,
 * linked to it on save; an unknown trip or day just opens an empty form.
 */
export default async function NewTourPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ trip?: string | string[]; day?: string | string[] }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const trip = one(sp.trip);
  const day = Number(one(sp.day));
  const [prefill, trips] = await Promise.all([trip && Number.isInteger(day) ? tourPrefill({ tripId: trip, day }) : null, listTrips()]);
  // Own trips for "Zu einer Reise hinzufügen" once the new tour is saved.
  const tripOptions = trips.ok ? trips.data.map((x) => ({ id: x.id, title: x.title ?? x.destination.name, lengthDays: x.lengthDays })) : [];
  return (
    <main className="flex flex-col gap-4">
      <TourEditor tour={null} view={null} prefill={prefill} mapStyleUrl={tourMapStyleUrl()} trips={tripOptions} />
    </main>
  );
}
