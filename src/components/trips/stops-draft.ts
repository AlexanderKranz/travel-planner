import type { ExtractedStop, ItineraryFlag } from "@/lib/domain/itinerary";
import { dayOfDate, MAX_STOPS_PER_DAY, MAX_TRIP_STOPS, sortStops, stopDate, type TripStop } from "@/lib/domain/trip-stops";
import { MAX_TRIP_DAYS } from "@/lib/domain/common";

/** One editable row of the stops list (strings for inputs; `key` for React). */
export type StopRow = {
  key: string;
  day: number;
  place: string;
  arr: string;
  dep: string;
  sea: boolean;
  note: string;
  /** Country hint from the AI extraction; kept so the saved stop keeps it, never shown or asked. */
  cc?: string;
  /** The date as printed in the document; cleared when the user changes the day. */
  date?: string;
  /** Extraction flags that stay true until the row is edited (outside_trip and no_trip_date are computed live). */
  flags: ItineraryFlag[];
};

let counter = 0;
const nextKey = () => `stop-${++counter}`;

export function emptyRow(day = 1): StopRow {
  return { key: nextKey(), day, place: "", arr: "", dep: "", sea: false, note: "", flags: [] };
}

export function rowFromStop(stop: TripStop, extra?: Pick<StopRow, "date" | "flags">): StopRow {
  return {
    key: nextKey(),
    day: stop.day,
    place: stop.place ?? "",
    arr: stop.arr ?? "",
    dep: stop.dep ?? "",
    sea: stop.sea === true,
    note: stop.note ?? "",
    ...(stop.cc ? { cc: stop.cc } : {}),
    ...(extra?.date ? { date: extra.date } : {}),
    flags: extra?.flags ?? [],
  };
}

export const rowsFromStops = (stops: readonly TripStop[]): StopRow[] => stops.map((s) => rowFromStop(s));

/** Extraction flags worth keeping on the row: the two trip-relative ones are recomputed from the form. */
const LIVE_FLAGS: ItineraryFlag[] = ["outside_trip", "no_trip_date"];
export function rowsFromExtracted(stops: readonly ExtractedStop[]): StopRow[] {
  return stops.map((e) => rowFromStop(e.stop, { date: e.date, flags: e.flags.filter((f) => !LIVE_FLAGS.includes(f)) }));
}

export function rowToStop(r: StopRow): TripStop {
  return {
    day: r.day,
    ...(r.sea ? { sea: true as const } : { place: r.place.trim() }),
    ...(r.cc && !r.sea ? { cc: r.cc } : {}),
    ...(r.arr ? { arr: r.arr } : {}),
    ...(r.dep ? { dep: r.dep } : {}),
    ...(r.note.trim() ? { note: r.note.trim() } : {}),
  };
}

/** The list the form saves: sorted by day, then arrival or departure (a stable sort keeps typed order). */
export const rowsToStops = (rows: readonly StopRow[]): TripStop[] => sortStops(rows.map(rowToStop));

export type RowProblem = "place" | "day";

/** What stops a row from being saved (the server checks again). */
export function rowProblems(r: StopRow, lengthDays: number): RowProblem[] {
  const out: RowProblem[] = [];
  if (!r.sea && r.place.trim() === "") out.push("place");
  if (!Number.isInteger(r.day) || r.day < 1 || r.day > Math.min(lengthDays, MAX_TRIP_DAYS)) out.push("day");
  return out;
}

/** Days with more places than a plan day can hold (MAX_STOPS_PER_DAY; sea rows do not count). */
export function overfullDays(rows: readonly StopRow[]): number[] {
  const perDay = new Map<number, number>();
  for (const r of rows) if (!r.sea) perDay.set(r.day, (perDay.get(r.day) ?? 0) + 1);
  return [...perDay].filter(([, n]) => n > MAX_STOPS_PER_DAY).map(([day]) => day).sort((a, b) => a - b);
}

export const rowsHaveProblems = (rows: readonly StopRow[], lengthDays: number) =>
  rows.length > MAX_TRIP_STOPS ||
  overfullDays(rows).length > 0 ||
  rows.some((r) => rowProblems(r, lengthDays).length > 0);

/** Warnings shown under a row: extraction flags plus the two that depend on the form's current dates. */
export function rowFlags(r: StopRow, ctx: { startDate: string | null; lengthDays: number }): ItineraryFlag[] {
  const flags = new Set<ItineraryFlag>(r.flags);
  if (r.day > ctx.lengthDays) flags.add("outside_trip");
  if (r.date && !ctx.startDate) flags.add("no_trip_date");
  return [...flags];
}

/** Message key under `trips.stops.flag` per flag (null = no warning of its own). */
export const FLAG_KEY: Record<ItineraryFlag, string | null> = {
  outside_trip: "outsideTrip",
  no_trip_date: "noTripDate",
  year_guessed: "yearGuessed",
  // The text path drops a stop that is not in the source before it reaches the preview.
  not_in_source: null,
  from_image: "fromImage",
  time_unclear: "timeUnclear",
};

/** Computed date of a row, or null when the trip has no start date. */
export const rowDate = (startDate: string | null, day: number): string | null =>
  startDate && Number.isInteger(day) && day >= 1 ? stopDate(startDate, day) : null;

/** "Fehlende Tage ergänzen": only proposal rows on days where the current list has no stop. Capped at the limit. */
export function fillMissingRows(current: readonly StopRow[], proposal: readonly StopRow[]): StopRow[] {
  const taken = new Set(current.map((r) => r.day));
  const add = proposal.filter((r) => !taken.has(r.day));
  return [...current, ...add].slice(0, MAX_TRIP_STOPS).sort((a, b) => a.day - b.day);
}

export type DatesOffer = { startDate: string; endDate: string; days: number };

/**
 * [D8] The trip dates the document implies, offered when the trip has no start date or some printed date does not
 * fit the trip. Null when the rows carry no dates, the range is too long, or the dates already fit.
 */
export function datesOffer(
  rows: readonly Pick<StopRow, "date">[],
  ctx: { startDate: string | null; lengthDays: number },
): DatesOffer | null {
  const dates = rows.flatMap((r) => (r.date ? [r.date] : [])).sort();
  if (dates.length === 0) return null;
  const startDate = dates[0]!;
  const endDate = dates[dates.length - 1]!;
  const days = dayOfDate(startDate, endDate);
  if (days < 1 || days > MAX_TRIP_DAYS) return null;
  if (ctx.startDate) {
    const start = ctx.startDate;
    const fits = dates.every((d) => {
      const n = dayOfDate(start, d);
      return n >= 1 && n <= ctx.lengthDays;
    });
    if (fits) return null;
  }
  return { startDate, endDate, days };
}

/**
 * What an upload sets on the trip besides the stops (Alex, 2026-11-12): the trip follows the document.
 * - Printed dates and no start date in the form: start date and length from the dates (the rows are remapped).
 * - Printed dates that do not fit a start date the user set: nothing; the dates offer stays for the user to take.
 * - Otherwise: the length becomes the last stop day.
 */
export function tripFitFromRows(
  rows: readonly StopRow[],
  ctx: { startDate: string | null; lengthDays: number },
): { startDate?: string; lengthDays?: number; stops: StopRow[] } {
  const offer = datesOffer(rows, ctx);
  if (offer && !ctx.startDate) {
    return { startDate: offer.startDate, lengthDays: offer.days, stops: remapRowsToStart(rows, offer.startDate) };
  }
  if (offer || rows.length === 0) return { stops: [...rows] };
  const last = Math.max(...rows.map((r) => r.day));
  return { lengthDays: Math.min(MAX_TRIP_DAYS, Math.max(1, last)), stops: [...rows] };
}

/** The first port of call (embarkation), offered as the trip destination when the user has not entered one. */
export function firstPlace(rows: readonly StopRow[]): { name: string; cc?: string } | null {
  const r = [...rows].sort((a, b) => a.day - b.day).find((x) => !x.sea && x.place.trim());
  return r ? { name: r.place.trim(), ...(r.cc ? { cc: r.cc } : {}) } : null;
}

/** Applies the offer to the rows that carry a printed date: their day follows the new start date. */
export function remapRowsToStart(rows: readonly StopRow[], startDate: string): StopRow[] {
  return rows.map((r) => (r.date ? { ...r, day: dayOfDate(startDate, r.date) } : r));
}

/** Applies an edit to a row. A changed place drops the extracted country hint: it belonged to the old place. */
export function patchRow(row: StopRow, patch: Partial<StopRow>): StopRow {
  const next = { ...row, ...patch };
  if (patch.place !== undefined && patch.place !== row.place && !("cc" in patch)) delete next.cc;
  return next;
}
