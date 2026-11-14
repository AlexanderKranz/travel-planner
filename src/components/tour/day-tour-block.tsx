import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { linkCls, mutedCls } from "@/components/ui/styles";
import { timeRange } from "@/lib/plan/fixed-items";
import type { TourBlock } from "@/lib/plan/tour-blocks";
import { RouteSketch } from "./route-sketch";
import { StopInfoToggle, TourReadOutBar, type StopRef } from "./stop-info/stop-info";

/** "Stadttour · 10:00–13:40 · 5 Orte · 4,2 km zu Fuß" (city-tour 10). */
export function useTourSummary() {
  const t = useTranslations("tours");
  const f = useFormatter();
  return (tour: TourBlock) =>
    t("dayBlock", {
      time: tour.from ? timeRange(tour.from, tour.to) : "none",
      count: tour.placeCount,
      km: tour.km === null ? "none" : f.number(tour.km, { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
      mode: tour.mode,
    });
}

/**
 * One city tour in its day card (city-tour 10), rendered from the stored snapshot only: collapsed summary line,
 * expandable to the ordered stops, the route sketch and "Tour öffnen". `access`: the viewer's access to the trip
 * (owner, or a grantee who opens the tour read-only); absent on the public share page (no link, no hint).
 */
export function DayTourBlock({ tour, access }: { tour: TourBlock; access?: "owner" | "write" | "read" }) {
  const t = useTranslations("tours");
  const summary = useTourSummary()(tour);
  // Stop info toggles (city-tour-stop-info 6): one per stop; a round trip's closing stop repeats the start, so none there.
  const refs =
    tour.stopKeys && tour.stopKeys.length === tour.stops.length
      ? tour.stops.map((name, i) => (i > 0 && tour.stopKeys![i] === tour.stopKeys![0] ? null : { key: tour.stopKeys![i], name, n: i + 1 }))
      : null;
  return (
    <li className="min-w-0 rounded-lg border border-l-4 border-info-line bg-info-bg/60 py-1.5 pl-3 pr-2" data-tour-block={tour.id}>
      <details className="group/tour min-w-0">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="text-subtle transition-transform group-open/tour:rotate-90">
            ›
          </span>
          <span className="min-w-0 break-words">{summary}</span>
        </summary>
        <div className="flex min-w-0 flex-col gap-2 pb-2 pl-5">
          {tour.title && <p className="break-words font-medium">{tour.title}</p>}
          {refs && <TourReadOutBar tourId={tour.id} stops={refs.filter((r): r is StopRef => r !== null)} />}
          <ol className="list-decimal pl-5 text-sm" aria-label={t("dayBlockStops")}>
            {tour.stops.map((name, i) => (
              <li key={i} className="break-words">
                {name}
                {refs?.[i] && <StopInfoToggle tourId={tour.id} stop={refs[i]} />}
              </li>
            ))}
          </ol>
          {tour.sketch && <RouteSketch legs={tour.sketch.legs} points={tour.sketch.points} />}
          {access && (
            <Link href={`/app/tours/${tour.id}`} className={`${linkCls} inline-flex min-h-11 items-center self-start`}>
              {t("openTour")}
            </Link>
          )}
        </div>
      </details>
      {!tour.from && access === "owner" && <p className={`pb-1 text-sm ${mutedCls}`}>{t("dayBlockNoTime")}</p>}
    </li>
  );
}
