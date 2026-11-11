/**
 * Stop-ref guard (port-places section 3, [P3]): a place of a stop may only be used on a day of that stop, a place of the
 * destination only on destination days (or within 10 km of that day's stop), and no place on a sea day. Prompt rule 17
 * says the same; code enforces it because prompt-only ref rules were not reliable before (issue #142). Pure.
 */
import type { OsmKey, PlanActivity } from "@/lib/domain/plan";
import { haversineKm } from "@/lib/facts/places";
import type { PlanInputStored } from "./input";

/** A destination place on a day of another stop is kept when it lies this close to one of the day's stop points. */
export const DEST_GRACE_KM = 10;

type Point = { lat: number; lon: number };

/** Built once per plan from the stored input (`stopRefCtx`). */
export type StopCtx = {
  /** The day's stop points (rows `at` a looked-up stop). */
  byDay: Map<number, Point[]>;
  /** Stop id -> days that have a row at it. */
  days: Record<string, number[]>;
  /** Days with a row at "dest", plus days with no row at all. */
  destDays: Set<number>;
  /** Days whose only rows are sea rows. */
  seaOnly: Set<number>;
  /** OSM key -> stop id of the place's list (absent = a destination place). */
  stopOfKey: Map<string, string>;
  pointOfKey: Map<string, Point>;
  /** Rows with times, by day, for the port-window guard. */
  rows: Map<number, NonNullable<PlanInputStored["llm"]["trip"]["stops"]>>;
};

/** The guard context of a stored input; undefined when the input has no `trip.stops` (older plans, no stops). */
export function stopRefCtx(stored: Pick<PlanInputStored, "llm" | "index" | "stopPoints">): StopCtx | undefined {
  const rows = stored.llm.trip?.stops;
  if (!rows?.length) return undefined;
  const byDay = new Map<number, Point[]>();
  const days: Record<string, number[]> = {};
  const destDays = new Set<number>();
  const seaOnly = new Set<number>();
  const rowsByDay = new Map<number, typeof rows>();
  for (const r of rows) rowsByDay.set(r.day, [...(rowsByDay.get(r.day) ?? []), r]);
  for (const [day, dayRows] of rowsByDay) {
    if (dayRows.every((r) => r.sea)) seaOnly.add(day);
    for (const r of dayRows) {
      // A row the code could not resolve (no `at`, not a sea row) says nothing about where the day is: destination day.
      if (r.at === "dest" || (!r.at && !r.sea)) destDays.add(day);
      else if (r.at) {
        days[r.at] = [...new Set([...(days[r.at] ?? []), day])];
        const p = stored.stopPoints?.[r.at];
        if (p) byDay.set(day, [...(byDay.get(day) ?? []), { lat: p.lat, lon: p.lon }]);
      }
    }
  }
  const total = stored.llm.dayList.length;
  for (let d = 1; d <= total; d++) if (!rowsByDay.has(d)) destDays.add(d);
  const stopOfKey = new Map<string, string>();
  const pointOfKey = new Map<string, Point>();
  for (const e of Object.values(stored.index)) {
    if (e.stop) stopOfKey.set(e.key, e.stop);
    pointOfKey.set(e.key, { lat: e.place.lat, lon: e.place.lon });
  }
  return { byDay, days, destDays, seaOnly, stopOfKey, pointOfKey, rows: rowsByDay };
}

/** May the place `key` be used on `day`? */
export function refAllowed(key: string, day: number, c: StopCtx): boolean {
  const stop = c.stopOfKey.get(key);
  if (stop) return c.days[stop]?.includes(day) === true;
  if (c.seaOnly.has(day)) return false;
  if (c.destDays.has(day)) return true;
  const here = c.pointOfKey.get(key);
  return !!here && (c.byDay.get(day) ?? []).some((p) => haversineKm(p, here) <= DEST_GRACE_KM);
}

/**
 * Removes refs and alts that may not be used on `day`; the first remaining one becomes the ref, as `guardOpenAir`
 * does. Without one the activity keeps its text and loses the ref. `dropped` counts removed keys.
 */
export function guardStopRefs(a: PlanActivity, day: number, c: StopCtx): { act: PlanActivity; dropped: number } {
  if (!a.ref) return { act: a, dropped: 0 };
  const keys = [a.ref, ...(a.alts ?? [])];
  const kept = keys.filter((k) => refAllowed(k, day, c)) as OsmKey[];
  const dropped = keys.length - kept.length;
  if (!dropped) return { act: a, dropped: 0 };
  const act: PlanActivity = { ...a };
  delete act.ref;
  delete act.alts;
  if (kept.length) {
    act.ref = kept[0];
    if (kept.length > 1) act.alts = kept.slice(1);
  }
  return { act, dropped };
}
