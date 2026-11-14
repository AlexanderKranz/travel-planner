/**
 * Time checks of a tour (docs/specs/city-tour.md section 7 [T10]). Pure arithmetic; tour times are local wall-clock
 * times of the city. Sunset uses `daylightFor` (suncalc) and `localHhmm` in the city's IANA zone, as the plan does.
 */
import type { TourFit, TourInput } from "@/lib/domain/tour";
import { daylightFor } from "@/lib/facts/daylight";
import { localHhmm } from "@/lib/plan/input";

export const hhmmToMin = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Minutes of the day → `HH:MM`, wrapping past midnight (a tour is one day; the UI may mark +1). */
export const minToHhmm = (m: number): string => {
  const x = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
};

/** The smaller of `maxMin` and `endBy − startTime` (spec 3.2); undefined when neither is set. */
export function effectiveMaxMin(i: Pick<TourInput, "maxMin" | "startTime" | "endBy">): number | undefined {
  const byEnd = i.startTime && i.endBy ? hhmmToMin(i.endBy) - hhmmToMin(i.startTime) : undefined;
  if (byEnd === undefined) return i.maxMin;
  return i.maxMin === undefined ? byEnd : Math.min(i.maxMin, byEnd);
}

/**
 * Total = Σ leg minutes + Σ dwell. `dwell[i]` belongs to stop i of the ordered sequence (one more stop than legs).
 * Null when a leg has no time (a failed leg: no total, never a guess).
 */
export function tourTotalMin(legMin: readonly (number | null)[], dwell: readonly number[]): number | null {
  if (legMin.some((m) => m === null)) return null;
  return (legMin as number[]).reduce((s, m) => s + m, 0) + dwell.reduce((s, d) => s + d, 0);
}

/**
 * One stop's times. With a time window (spec 17.4): `waitMin` minutes waited before the visit starts (arrival before
 * `after`), `lateMin` minutes the visit starts after `before` (the window is missed; never dropped silently).
 */
export type StopTime = { arrive: string; leave: string; waitMin?: number; lateMin?: number };
/** A stop's window as wall-clock `HH:MM` of the tour day; undefined = no window. */
export type StopWindow = { after?: string; before?: string } | undefined;

/** Minutes waited when arriving at minute-of-day `arrive` (0 without an `after`). */
export const waitFor = (arrive: number, w: StopWindow): number => (w?.after ? Math.max(0, hhmmToMin(w.after) - arrive) : 0);

/**
 * Arrive and leave time of each stop from a start time; null when a leg has no time. With windows, a stop reached
 * before its `after` waits (the wait shifts everything after it) and a visit starting after its `before` is late.
 */
export function stopTimes(
  startTime: string,
  legMin: readonly (number | null)[],
  dwell: readonly number[],
  windows: readonly StopWindow[] = [],
): StopTime[] | null {
  if (legMin.some((m) => m === null)) return null;
  const out: StopTime[] = [];
  let t = hhmmToMin(startTime);
  for (let i = 0; i < dwell.length; i++) {
    const arrive = t;
    const w = windows[i];
    const wait = waitFor(arrive, w);
    const begin = arrive + wait;
    const late = w?.before ? Math.max(0, begin - hhmmToMin(w.before)) : 0;
    t = begin + dwell[i];
    out.push({ arrive: minToHhmm(arrive), leave: minToHhmm(t), ...(wait > 0 ? { waitMin: wait } : {}), ...(late > 0 ? { lateMin: late } : {}) });
    if (i < legMin.length) t += legMin[i]!;
  }
  return out;
}

/** Σ waits of `stopTimes` (0 without windows); added to the total so the tour's length includes waiting. */
export const totalWaitMin = (times: readonly StopTime[] | null): number => (times ?? []).reduce((s, x) => s + (x.waitMin ?? 0), 0);

export type FitCheck = { fit: TourFit; /** minutes over the max or free below the min */ byMin?: number };

/** Fit badge: "none" without a limit or without a total. */
export function tourFit(totalMin: number | null, minMin: number | undefined, maxMin: number | undefined): FitCheck {
  if (totalMin === null || (minMin === undefined && maxMin === undefined)) return { fit: "none" };
  if (maxMin !== undefined && totalMin > maxMin) return { fit: "over", byMin: totalMin - maxMin };
  if (minMin !== undefined && totalMin < minMin) return { fit: "under", byMin: minMin - totalMin };
  return { fit: "ok" };
}

/**
 * Local sunset `HH:MM` when the tour ends after it, else undefined. Needs date, start time, a total, the centre and
 * the city's IANA zone (without a zone the local time is unknown, so no warning). Polar day or night: undefined.
 */
export function sunsetWarning(a: {
  date?: string;
  startTime?: string;
  totalMin: number | null;
  centre: { lat: number; lon: number } | null;
  timeZone?: string | null;
}): string | undefined {
  if (!a.date || !a.startTime || a.totalMin === null || !a.centre || !a.timeZone) return undefined;
  const [day] = daylightFor(a.centre.lat, a.centre.lon, [a.date]);
  const sunset = localHhmm(day.sunset, a.timeZone);
  if (!sunset) return undefined;
  return hhmmToMin(a.startTime) + a.totalMin > hhmmToMin(sunset) ? sunset : undefined;
}
