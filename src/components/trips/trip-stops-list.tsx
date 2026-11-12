import { getFormatter, getTranslations } from "next-intl/server";
import { cardCls, focusCls, linkCls, pillCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import type { Trip } from "@/lib/domain";
import { canEdit } from "@/lib/domain/sharing";
import { getShownStopsOnce } from "@/lib/server/request-reads";
import { stopListRows, type StopTimes } from "./stops-list-rows";

/** Anchor of the list; the stop count in the trip context strip links here. */
export const STOPS_ANCHOR = "stops";

/**
 * Read-only stops of a multi-stop trip on the trip page (itinerary-upload section 6, issue #185): confirmed stops,
 * else the ones derived from the saved notes (labelled as such). Every viewer sees it; only owner and write grantees
 * get the edit link. Nothing for a trip without stops.
 */
export async function TripStopsList({ trip }: { trip: Trip }) {
  const { stops, source } = await getShownStopsOnce(trip.id);
  if (stops.length === 0) return null;
  const t = await getTranslations("trips.stops");
  const f = await getFormatter();
  const startDate = trip.timing.kind === "date" ? trip.timing.startDate : null;
  const fmt = (iso: string) =>
    f.dateTime(new Date(`${iso}T00:00:00Z`), { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const times = (x: StopTimes) =>
    !x ? null : x.kind === "range" ? x.text : x.kind === "arr" ? t("arriveAt", { time: x.time }) : t("departAt", { time: x.time });

  return (
    <section id={STOPS_ANCHOR} aria-labelledby="trip-stops-title" className={`${cardCls} min-w-0 scroll-mt-4`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <h2 id="trip-stops-title" className="text-lg font-bold">
          {t("title")}
        </h2>
        {canEdit(trip.access) && (
          <Link href={`/app/trips/${trip.id}/edit#field-stops`} className={`${linkCls} inline-flex min-h-11 items-center text-sm`} data-no-print>
            {t("edit")}
          </Link>
        )}
      </div>
      {source === "notes" && <p className="text-sm text-muted">{t("derived", { count: stops.length })}</p>}
      <ol className="mt-2 flex flex-col">
        {stopListRows(stops, startDate).map((r, i) => {
          const time = times(r.times);
          return (
            <li key={i} className="flex min-w-0 flex-col gap-0.5 border-t border-line py-2 first:border-t-0 sm:grid sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-x-4">
              <span className="text-sm text-muted tabular-nums">
                {r.date ? t("dayOption", { n: r.day, date: fmt(r.date) }) : t("dayOptionNoDate", { n: r.day })}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className={r.sea ? "italic text-muted" : "break-words font-medium"}>{r.sea ? t("sea") : r.place}</span>
                {(time || r.note) && (
                  <span className="break-words text-sm text-muted">
                    {time && <span className="tabular-nums">{time}</span>}
                    {time && r.note && " · "}
                    {r.note}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The stop count in the trip context strip, linked to the list above; nothing without stops. */
export async function TripStopsCount({ tripId }: { tripId: string }) {
  const { stops } = await getShownStopsOnce(tripId);
  if (stops.length === 0) return null;
  const t = await getTranslations("trips.stops");
  return (
    <li>
      {/* The pill stays small; the invisible ::after extends the hit area to 44 px. */}
      <a
        href={`#${STOPS_ANCHOR}`}
        className={`${pillCls} ${focusCls} relative underline-offset-2 after:absolute after:inset-x-0 after:-inset-y-3 after:content-[''] hover:bg-hover hover:underline`}
      >
        {t("count", { count: stops.length })}
      </a>
    </li>
  );
}
