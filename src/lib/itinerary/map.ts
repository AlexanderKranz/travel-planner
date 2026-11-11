import { MAX_TRIP_DAYS } from "@/lib/domain/common";
import type { ExtractedStop, ItineraryContext, ItineraryFlag } from "@/lib/domain/itinerary";
import { dayOfDate, MAX_TRIP_STOPS, stopDate, TripStop } from "@/lib/domain/trip-stops";
import { foldText } from "./text";

/**
 * One stop as read from a source, before it is placed on the trip (parser output, and the normalized AI extraction
 * that is cached in `itinerary_extracts`). Independent of the trip dates, so a cached extraction maps again when the
 * user changes the dates in the form.
 * - `date`: `YYYY-MM-DD`, or `--MM-DD` when the source printed no year (the year is guessed at mapping).
 * - `day`: a printed day number ("Tag 3").
 * - Neither: same day as the stop before (a second port on one line or row).
 */
export type RawStop = {
  date?: string;
  day?: number;
  place?: string;
  cc?: string;
  arr?: string;
  dep?: string;
  sea?: true;
  note?: string;
  flags?: ItineraryFlag[];
};

const FULL = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEARLESS = /^--(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

export function isValidIso(iso: string): boolean {
  const m = FULL.exec(iso);
  if (!m) return false;
  const d = new Date(utc(iso));
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** `--MM-DD` with a real month and day (29 Feb allowed). */
export function isValidYearless(md: string): boolean {
  const m = YEARLESS.exec(md);
  return m !== null && isValidIso(`2000-${m[1]}-${m[2]}`);
}

/** Distance in days from `iso` to the interval [from, to] (0 inside). */
function distance(iso: string, from: string, to: string): number {
  const t = utc(iso);
  if (t < utc(from)) return (utc(from) - t) / DAY_MS;
  if (t > utc(to)) return (t - utc(to)) / DAY_MS;
  return 0;
}

/** A real date for `--MM-DD` in year `y` (29 Feb only in leap years). */
function inYear(md: string, y: number): string | null {
  const iso = `${String(y).padStart(4, "0")}${md.slice(1)}`;
  return isValidIso(iso) ? iso : null;
}

/**
 * The year of a date printed without one (section 3.3): with trip dates, the year that puts it inside or nearest the
 * trip; without, the next occurrence on or after `today` (itineraries are for trips ahead).
 */
export function guessYear(md: string, ctx: ItineraryContext, today: string): string | null {
  if (!isValidYearless(md)) return null;
  if (ctx.startDate) {
    const end = stopDate(ctx.startDate, ctx.lengthDays);
    const y = Number(ctx.startDate.slice(0, 4));
    const options = [y - 1, y, y + 1].map((x) => inYear(md, x)).filter((d): d is string => d !== null);
    options.sort((a, b) => distance(a, ctx.startDate!, end) - distance(b, ctx.startDate!, end));
    return options[0] ?? null;
  }
  const y = Number(today.slice(0, 4));
  for (const x of [y, y + 1, y + 2, y + 3, y + 4]) {
    const d = inYear(md, x);
    if (d && d >= today) return d;
  }
  return null;
}

const clampDay = (d: number) => Math.min(MAX_TRIP_DAYS, Math.max(1, d));

/** The same stop twice (a model or a document repeating a row). */
const stopKey = (s: TripStop) => [s.day, s.sea ? "~sea" : foldText(s.place ?? ""), s.arr ?? "", s.dep ?? ""].join("|");

/**
 * Places raw stops on the trip (section 3.5): dates map to days with the trip's start date as it is in the form right
 * now; printed day numbers stay. Flags per stop:
 * - `year_guessed`: the date had no year (`guessYear`).
 * - `no_trip_date`: dates found but the trip has no start date. Days then count from the earliest date found (or the
 *   printed day number), so the list still has an order; the form offers to take the dates over ([D8]).
 * - `outside_trip`: before the start, after the end, or day > length. The day is clamped to 1..MAX_TRIP_DAYS so the
 *   stop stays a valid `TripStop`; `date` keeps the real date.
 * Flags from the source (`not_in_source`, `from_image`, `time_unclear`) are kept. Invalid stops are dropped, exact
 * duplicates too. Sorted by day, then arr ?? dep; at most MAX_TRIP_STOPS.
 */
export function mapStops(raw: readonly RawStop[], ctx: ItineraryContext, today: string): ExtractedStop[] {
  type Dated = { r: RawStop; iso?: string; flags: Set<ItineraryFlag> };
  const dated: Dated[] = raw.map((r) => {
    const flags = new Set(r.flags ?? []);
    let iso: string | undefined;
    if (r.date && isValidIso(r.date)) iso = r.date;
    else if (r.date && isValidYearless(r.date)) {
      iso = guessYear(r.date, ctx, today) ?? undefined;
      if (iso) flags.add("year_guessed");
    }
    return { r, iso, flags };
  });

  const anyDate = dated.some((d) => d.iso);
  const base = ctx.startDate ?? dated.map((d) => d.iso).filter((d): d is string => !!d).sort()[0];

  const out: ExtractedStop[] = [];
  const seen = new Set<string>();
  let prevDay: number | null = null;
  for (const d of dated) {
    let day: number | null = null;
    if (d.iso && ctx.startDate) day = dayOfDate(ctx.startDate, d.iso);
    else if (d.r.day !== undefined && Number.isInteger(d.r.day)) day = d.r.day;
    else if (d.iso && base) day = dayOfDate(base, d.iso);
    else day = prevDay;
    if (day === null) continue;
    prevDay = day;
    if (anyDate && !ctx.startDate) d.flags.add("no_trip_date");
    if (day < 1 || day > ctx.lengthDays) d.flags.add("outside_trip");

    const candidate = {
      day: clampDay(day),
      ...(d.r.sea ? { sea: true as const } : { place: d.r.place }),
      ...(d.r.cc && !d.r.sea ? { cc: d.r.cc } : {}),
      ...(d.r.arr ? { arr: d.r.arr } : {}),
      ...(d.r.dep ? { dep: d.r.dep } : {}),
      ...(d.r.note ? { note: d.r.note } : {}),
    };
    const parsed = TripStop.safeParse(candidate);
    if (!parsed.success) continue;
    const key = stopKey(parsed.data);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ stop: parsed.data, ...(d.iso ? { date: d.iso } : {}), flags: [...d.flags].sort() });
  }
  // Stable: same day and time keep the printed order.
  out.sort((a, b) => a.stop.day - b.stop.day || (a.stop.arr ?? a.stop.dep ?? "").localeCompare(b.stop.arr ?? b.stop.dep ?? ""));
  return out.slice(0, MAX_TRIP_STOPS);
}

/** Stops the plan may use without confirmation (notes derivation, [D10]): everything outside the trip is dropped. */
export function derivableStops(stops: readonly ExtractedStop[]): TripStop[] {
  return stops.filter((s) => !s.flags.includes("outside_trip")).map((s) => s.stop);
}

/** ISO date of today in UTC (default `today` of the pure functions; callers on the server pass Berlin's). */
export const utcToday = (now: Date = new Date()) => now.toISOString().slice(0, 10);
