import type { Trip } from "@/lib/domain/trip";
import { referenceDates } from "./trip-timing";

/** Home zone when the user set none. The label is a message key (Deutschland / Germany). */
export const DEFAULT_HOME_TIMEZONE = "Europe/Berlin";

/** True for a zone name the runtime's tz database knows (e.g. "Asia/Kolkata"). */
export function isValidTimeZone(iana: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: iana });
    return true;
  } catch {
    return false;
  }
}

function offsetFormatter(iana: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: iana, timeZoneName: "longOffset" });
}

function offsetAt(fmt: Intl.DateTimeFormat, date: string): string | null {
  const part = fmt.formatToParts(new Date(`${date}T12:00:00Z`)).find((p) => p.type === "timeZoneName")?.value ?? "";
  const m = /GMT([+-]\d{2}:\d{2})?/.exec(part);
  return m ? (m[1] ?? "+00:00") : null;
}

/** UTC offsets ("+01:00") of an IANA zone on the given dates, via Intl (handles DST). Sorted, unique. */
export function utcOffsets(iana: string, dates: string[]): string[] {
  const fmt = offsetFormatter(iana);
  const out = new Set<string>();
  for (const d of dates) {
    const o = offsetAt(fmt, d);
    if (o) out.add(o);
  }
  return [...out].sort();
}

function toMinutes(offset: string): number {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  return sign * (h * 60 + m);
}

/**
 * Destination minus home, in minutes, for each distinct value over the dates in date order
 * (positive = destination clock is ahead). One value = constant, two or more = daylight saving differs.
 */
export function timeDifferenceMinutes(destIana: string, homeIana: string, dates: string[]): number[] {
  const dest = offsetFormatter(destIana);
  const home = offsetFormatter(homeIana);
  const out: number[] = [];
  for (const d of dates) {
    const a = offsetAt(dest, d);
    const b = offsetAt(home, d);
    if (a === null || b === null) continue;
    const diff = toMinutes(a) - toMinutes(b);
    if (!out.includes(diff)) out.push(diff);
  }
  return out;
}

export type TimeDifference = {
  /** Distinct differences in minutes, in date order (start of trip first). Never empty. */
  minutes: number[];
  /** Candidate months: the values belong to different months, not to one journey. */
  byMonth: boolean;
};

/**
 * Time difference of the destination to home on the trip's reference dates (same logic as the country facts:
 * trip days, the 15th of candidate months, or today). Null when the destination has no zone or a zone is invalid.
 */
export function tripTimeDifference(
  trip: Pick<Trip, "destination" | "timing" | "lengthDays">,
  homeIana: string | null,
  today: string,
): TimeDifference | null {
  const dest = trip.destination.kind === "freetext" ? null : trip.destination.timezone;
  const home = homeIana ?? DEFAULT_HOME_TIMEZONE;
  if (!dest || !isValidTimeZone(dest) || !isValidTimeZone(home)) return null;
  const refs = referenceDates(trip, today);
  const minutes = timeDifferenceMinutes(dest, home, refs.length ? refs : [today]);
  return minutes.length ? { minutes, byMonth: trip.timing.kind === "months" } : null;
}

/** "+1", "−5", "+5:30", "−3:30", "0" (real minus sign). Unit and wording are the caller's business. */
export function formatHours(minutes: number): string {
  if (minutes === 0) return "0";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${minutes < 0 ? "−" : "+"}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}
