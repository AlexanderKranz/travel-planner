import type { Trip } from "@/lib/domain/trip";

type Timing = Trip["timing"];
const pad = (n: number) => String(n).padStart(2, "0");

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 15th of the next occurrence of `month` on or after the month of `today` (YYYY-MM-DD, Berlin). */
export function nextOccurrence15th(month: number, today: string): string {
  const [y, m] = today.split("-").map(Number);
  return `${month >= m ? y : y + 1}-${pad(month)}-15`;
}

/** Reference dates: every trip day (date), the 15th of each candidate month (months), none otherwise. */
export function referenceDates(trip: Pick<Trip, "timing" | "lengthDays">, today: string): string[] {
  const t: Timing = trip.timing;
  if (t.kind === "date") return Array.from({ length: trip.lengthDays }, (_, i) => addDays(t.startDate, i));
  if (t.kind === "months") return t.months.map((m) => nextOccurrence15th(m, today)).sort();
  return [];
}

/** Months touched by the trip (date), the candidate months (months), or empty (12-month overview). */
export function selectedMonths(trip: Pick<Trip, "timing" | "lengthDays">): number[] {
  const t = trip.timing;
  if (t.kind === "months") return [...t.months];
  if (t.kind !== "date") return [];
  const set = new Set<number>();
  for (let i = 0; i < trip.lengthDays; i++) set.add(Number(addDays(t.startDate, i).slice(5, 7)));
  return [...set].sort((a, b) => a - b);
}

/** Age reference date: start date, earliest next-occurrence month 15th, or null (today). */
export function ageReferenceDate(trip: Pick<Trip, "timing" | "lengthDays">, today: string): string | null {
  const dates = referenceDates(trip, today);
  return dates.length ? dates[0] : null;
}

/** Dates for the daylight table (spec 3.2). */
export function daylightDates(
  trip: Pick<Trip, "timing" | "lengthDays">,
  today: string,
): { basis: "trip_dates" | "mid_month"; dates: string[] } {
  const t = trip.timing;
  if (t.kind === "date") {
    const all = referenceDates(trip, today);
    if (all.length <= 14) return { basis: "trip_dates", dates: all };
    const picked = all.filter((_, i) => i % 7 === 0 || i === all.length - 1);
    return { basis: "trip_dates", dates: picked };
  }
  if (t.kind === "months") return { basis: "mid_month", dates: referenceDates(trip, today) };
  const year = today.slice(0, 4);
  return { basis: "mid_month", dates: Array.from({ length: 12 }, (_, i) => `${year}-${pad(i + 1)}-15`) };
}
