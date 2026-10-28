import type { Trip } from "@/lib/domain/trip";

export const HORIZON_DAYS = 360;
export const TRIP_UNIT_CAP = 32;

export type FlightDates = {
  basis: "trip_dates" | "sample_week";
  outDate: string;
  backDate: string;
  mode: { out: "schedule" | "proxy"; back: "schedule" | "proxy" };
  checked: { out: string; back: string };
};

const MS_DAY = 86_400_000;
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

export function addDays(date: string, n: number): string {
  return iso(ms(date) + n * MS_DAY);
}
export function daysBetween(a: string, b: string): number {
  return Math.round((ms(b) - ms(a)) / MS_DAY);
}
/** 1=Mo..7=Su */
export function isoWeekday(date: string): number {
  return ((new Date(ms(date)).getUTCDay() + 6) % 7) + 1;
}
export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Proxy for a date beyond the horizon: same month and day-of-month in the latest year whose shifted date lies
 * before `today`, then moved to the nearest same weekday (-3..+3 days; stays in the month if possible).
 * 2038-03-13 (Sat) -> 2026-03-14 (Sat).
 */
export function proxyDate(date: string, today: string): string {
  const [y0, m, d] = date.split("-").map(Number);
  const wd = isoWeekday(date);
  for (let y = Number(today.slice(0, 4)); y > 1990; y--) {
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const base = `${y}-${String(m).padStart(2, "0")}-${String(Math.min(d, dim)).padStart(2, "0")}`;
    if (base >= today) continue;
    let diff = (wd - isoWeekday(base) + 7) % 7;
    if (diff > 3) diff -= 7;
    let cand = addDays(base, diff);
    if (cand.slice(0, 7) !== base.slice(0, 7)) cand = addDays(cand, diff > 0 ? -7 : 7);
    if (cand >= today) continue;
    return cand;
  }
  return date.replace(String(y0), String(Number(today.slice(0, 4)) - 1));
}

/** First Saturday on/after the 8th of `month` (sample week for months mode, spec D2). */
export function sampleSaturday(year: number, month: number): string {
  const d8 = `${year}-${String(month).padStart(2, "0")}-08`;
  return addDays(d8, (6 - isoWeekday(d8) + 7) % 7);
}

function lastSunday(year: number, month: number): string {
  const last = `${year}-${String(month).padStart(2, "0")}-${daysInMonth(`${year}-${String(month).padStart(2, "0")}`)}`;
  return addDays(last, -(isoWeekday(last) % 7));
}

/**
 * Date for routes/daily (statistics cover the 7 days BEFORE it): the 15th of the month; in March/October when
 * `date` lies on/after the last Sunday (season change) the last day of the month.
 */
export function routesSampleDate(date: string): string {
  const [y, m] = date.split("-").map(Number);
  const ym = `${y}-${String(m).padStart(2, "0")}`;
  if ((m === 3 || m === 10) && date >= lastSunday(y, m)) return `${ym}-${daysInMonth(ym)}`;
  return `${ym}-15`;
}

function shift(date: string, today: string): { checked: string; mode: "schedule" | "proxy" } {
  return daysBetween(today, date) <= HORIZON_DAYS ? { checked: date, mode: "schedule" } : { checked: proxyDate(date, today), mode: "proxy" };
}

/** Dates to look up for a trip (spec section 1); null = no_dates. */
export function flightDates(trip: Pick<Trip, "timing" | "lengthDays">, today: string): FlightDates | null {
  let basis: FlightDates["basis"];
  let outDate: string;
  if (trip.timing.kind === "date") {
    basis = "trip_dates";
    outDate = trip.timing.startDate;
  } else if (trip.timing.kind === "months" && trip.timing.months.length > 0) {
    basis = "sample_week";
    const m = trip.timing.months[0];
    const todayMonth = Number(today.slice(5, 7));
    const year = Number(today.slice(0, 4)) + (m < todayMonth ? 1 : 0);
    outDate = sampleSaturday(year, m);
    if (outDate < today) outDate = sampleSaturday(year + 1, m); // current month already past the 8th week
  } else return null;
  const backDate = addDays(outDate, trip.lengthDays - 1);
  const o = shift(outDate, today);
  const b = shift(backDate, today);
  return { basis, outDate, backDate, mode: { out: o.mode, back: b.mode }, checked: { out: o.checked, back: b.checked } };
}

/** TTL seconds per lookup (spec 1.2): past 90 d; routes future 7 d (<= 30 d ahead) else 14 d; FIDS/dates 7 d. */
export function lookupTtlSeconds(kind: "routes_daily" | "fids_departures" | "flight_dates", date: string, today: string): number {
  const day = 86_400;
  if (date < today) return 90 * day;
  if (kind === "routes_daily") return (daysBetween(today, date) <= 30 ? 7 : 14) * day;
  return 7 * day;
}
