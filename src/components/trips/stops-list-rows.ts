import { stopDate, type TripStop } from "@/lib/domain/trip-stops";
import { timeRange } from "@/lib/plan/fixed-items";

/** Times of one stop: both ("07:00–18:00", "+1" after midnight), only arrival, only departure, or none. */
export type StopTimes = { kind: "range"; text: string } | { kind: "arr"; time: string } | { kind: "dep"; time: string } | null;

/** One row of the read-only stops list (trip detail page). Place and note are user data, shown as typed. */
export type StopListRow = {
  day: number;
  /** ISO date of the trip day; null when the trip has no dates. */
  date: string | null;
  /** Null on a sea day. */
  place: string | null;
  sea: boolean;
  times: StopTimes;
  note: string | null;
};

export function stopTimes(stop: Pick<TripStop, "arr" | "dep">): StopTimes {
  if (stop.arr && stop.dep) return { kind: "range", text: timeRange(stop.arr, stop.dep) };
  if (stop.arr) return { kind: "arr", time: stop.arr };
  if (stop.dep) return { kind: "dep", time: stop.dep };
  return null;
}

/** The rows in the stops' (sorted) order; `startDate` only for trips with dates. Pure, no formatting. */
export function stopListRows(stops: readonly TripStop[], startDate: string | null): StopListRow[] {
  return stops.map((s) => ({
    day: s.day,
    date: startDate ? stopDate(startDate, s.day) : null,
    place: s.sea ? null : (s.place ?? null),
    sea: s.sea === true,
    times: stopTimes(s),
    note: s.note ?? null,
  }));
}
