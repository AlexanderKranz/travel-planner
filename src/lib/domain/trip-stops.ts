import { z } from "zod";
import { MAX_TRIP_DAYS } from "./common";
import { HHMM } from "./plan";
import type { Trip } from "./trip";

/**
 * The one stop schema of a trip (docs/specs/itinerary-upload.md section 2 [D4]). The plan input, the port-window
 * guard and the per-stop place lookups (docs/specs/port-places.md) use it unchanged. Pure, no I/O.
 */
export const MAX_TRIP_STOPS = 40;

export const TripStop = z
  .object({
    /** Trip day, 1-based. The date is computed (`stopDate`), never stored, so moving the start moves the schedule. */
    day: z.number().int().min(1).max(MAX_TRIP_DAYS),
    /** Required unless `sea`. */
    place: z.string().trim().min(1).max(80).optional(),
    /** Country hint for geocoding; set by the AI extraction, never asked from the user. */
    cc: z.string().regex(/^[A-Z]{2}$/).optional(),
    /** Local time as printed. `dep` before `arr` means "departs after midnight" (`timeRange` renders +1). */
    arr: HHMM.optional(),
    dep: HHMM.optional(),
    /** Sea or river day, no port. */
    sea: z.literal(true).optional(),
    /** "Ankunft morgens", "Tenderhafen". */
    note: z.string().trim().max(60).optional(),
  })
  .refine((s) => (s.sea === true) !== (s.place !== undefined), {
    message: "A stop has either a place or sea, not both and not neither",
    path: ["place"],
  });
export type TripStop = z.infer<typeof TripStop>;

/** Sorted by day, then arr ?? dep (a stable sort, so equal keys keep their input order). */
export function sortStops<T extends Pick<TripStop, "day" | "arr" | "dep">>(stops: readonly T[]): T[] {
  return [...stops].sort((a, b) => a.day - b.day || (a.arr ?? a.dep ?? "").localeCompare(b.arr ?? b.dep ?? ""));
}

/** Validated list, normalized to sorted order (the form may send rows in any order). */
export const TripStops = z
  .array(TripStop)
  .max(MAX_TRIP_STOPS)
  .transform((stops) => sortStops(stops));
export type TripStopsInput = z.input<typeof TripStops>;

const DAY_MS = 86_400_000;
const utc = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/** Date of trip day `day` (1-based): start + day - 1. */
export function stopDate(startDate: string, day: number): string {
  return new Date(utc(startDate) + (day - 1) * DAY_MS).toISOString().slice(0, 10);
}

/** Trip day (1-based) of `date`; may be < 1 or > length when the date lies outside the trip. */
export function dayOfDate(startDate: string, date: string): number {
  return Math.round((utc(date) - utc(startDate)) / DAY_MS) + 1;
}

/** The stops that lie after the last day of the trip. Not savable until the user changes them or the trip length. */
export function stopsOutsideTrip<T extends Pick<TripStop, "day">>(stops: readonly T[], lengthDays: number): T[] {
  return stops.filter((s) => s.day > lengthDays);
}

/** Drops the stops outside the trip (derived notes stops are dropped, not flagged; itinerary-upload section 3.5). */
export function fitStopsToTrip<T extends Pick<TripStop, "day">>(stops: readonly T[], lengthDays: number): T[] {
  return stops.filter((s) => s.day <= lengthDays);
}

/** Stops grouped by trip day (rows keep their order). */
export function stopsByDay<T extends Pick<TripStop, "day">>(stops: readonly T[]): Map<number, T[]> {
  const byDay = new Map<number, T[]>();
  for (const s of stops) byDay.set(s.day, [...(byDay.get(s.day) ?? []), s]);
  return byDay;
}

/** Value equality of two stop lists (order matters; both are kept sorted). */
export function sameStops(a: readonly TripStop[] | null | undefined, b: readonly TripStop[] | null | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/** Reads the stored jsonb: a valid list, else none (a corrupt value never breaks the trip). */
export function parseStoredStops(raw: unknown): TripStop[] {
  const parsed = TripStops.safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}

/**
 * Stops derived from the trip notes ([D10]). Produced by the server (parser, then Haiku text path; cached in
 * `itinerary_extracts`) and handed to `tripStops` by the caller. `notes` is the exact notes text they were derived
 * from, so a stale result is ignored.
 */
export type DerivedStops = { notes: string; stops: readonly TripStop[] };

/**
 * The stops the plan uses ([D10]): confirmed `trips.stops`, else stops derived from `trip.notes`, else none.
 * Pure and synchronous: the caller loads `derived` (see `resolveTripStops` in `src/lib/server/trip-stops.ts`).
 * - Confirmed stops are used as saved (sorted); an empty confirmed list counts as "none confirmed".
 * - Derived stops are used only when they belong to the current notes; stops outside the trip are dropped.
 * - Where a stop came from does not matter to the caller.
 */
export function tripStops(
  trip: Pick<Trip, "stops" | "notes" | "lengthDays">,
  derived?: DerivedStops | null,
): TripStop[] {
  if (trip.stops && trip.stops.length > 0) return sortStops(trip.stops);
  if (derived && trip.notes !== undefined && derived.notes === trip.notes) {
    return sortStops(fitStopsToTrip(derived.stops, trip.lengthDays));
  }
  return [];
}
