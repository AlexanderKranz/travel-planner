/**
 * Stop-ref guard (port-places section 3, [P3]): a place of a stop may only be used on a day of that stop, a place of the
 * destination only on destination days (or within 10 km of that day's stop), and no place on a sea day. Prompt rule 17
 * says the same; code enforces it because prompt-only ref rules were not reliable before (issue #142). Pure.
 */
import type { OsmKey, PlanActivity } from "@/lib/domain/plan";
import { haversineKm } from "@/lib/facts/places";
import type { PlanInputStored } from "./input";
import { placeMatches } from "./place-match";

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
  /** OSM key -> stop id of the first lookup that listed the place (absent = a destination place). */
  stopOfKey: Map<string, string>;
  /** OSM key -> every stop whose list in the input holds the place (two stops' lookups may return the same place). */
  stopsOfKey: Map<string, Set<string>>;
  /** Keys of destination places (index entries without a stop). */
  destKeys: Set<string>;
  /** Stop id -> its point. */
  pointOfStop: Map<string, Point>;
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
  const stopsOfKey = new Map<string, Set<string>>();
  const destKeys = new Set<string>();
  const pointOfKey = new Map<string, Point>();
  const addStop = (key: string, stop: string) => stopsOfKey.set(key, new Set([...(stopsOfKey.get(key) ?? []), stop]));
  for (const e of Object.values(stored.index)) {
    if (e.stop) {
      stopOfKey.set(e.key, e.stop);
      addStop(e.key, e.stop);
    } else destKeys.add(e.key);
    pointOfKey.set(e.key, { lat: e.place.lat, lon: e.place.lon });
  }
  // The index tags a place with the first stop that listed it; the input lists its id under every stop that found it.
  for (const sp of stored.llm.stopPlaces ?? []) {
    const ids = [...(sp.places ?? []), ...(sp.restaurants?.list ?? []), ...(sp.cafes?.list ?? [])].map((p) => p.id);
    for (const id of ids) {
      const e = Object.hasOwn(stored.index, id) ? stored.index[id] : undefined;
      if (e) addStop(e.key, sp.id);
    }
  }
  const pointOfStop = new Map<string, Point>();
  for (const [id, p] of Object.entries(stored.stopPoints ?? {})) pointOfStop.set(id, { lat: p.lat, lon: p.lon });
  return { byDay, days, destDays, seaOnly, stopOfKey, stopsOfKey, destKeys, pointOfStop, pointOfKey, rows: rowsByDay };
}

/**
 * Where the plan stop `place` of `day` is: the `at` of the day's schedule rows that name it ("dest" or stop ids).
 * Undefined when no row names it (then only the day decides).
 */
function atsOf(day: number, place: string | undefined, c: StopCtx): Set<string> | undefined {
  if (!place) return undefined;
  const ats = (c.rows.get(day) ?? []).filter((r) => r.place && r.at && placeMatches(place, r.place)).map((r) => r.at!);
  return ats.length ? new Set(ats) : undefined;
}

/**
 * May the place `key` be used on `day`? With `place` (the plan stop the activity sits in) the check is against that
 * stop and its schedule row, so a Melk restaurant inside the Dürnstein stop fails although both are on day 3.
 */
export function refAllowed(key: string, day: number, c: StopCtx, place?: string): boolean {
  const ats = atsOf(day, place, c);
  const stops = c.stopsOfKey.get(key);
  if (stops?.size && [...stops].some((s) => (ats ? ats.has(s) : c.days[s]?.includes(day) === true))) return true;
  if (!c.destKeys.has(key) && stops?.size) return false;
  // A destination place (or one without a known stop).
  if (ats) {
    if (ats.has("dest")) return true;
    const here = c.pointOfKey.get(key);
    return !!here && [...ats].some((s) => { const p = c.pointOfStop.get(s); return !!p && haversineKm(p, here) <= DEST_GRACE_KM; });
  }
  if (c.seaOnly.has(day)) return false;
  if (c.destDays.has(day)) return true;
  const here = c.pointOfKey.get(key);
  return !!here && (c.byDay.get(day) ?? []).some((p) => haversineKm(p, here) <= DEST_GRACE_KM);
}

/**
 * Removes refs and alts that may not be used on `day`; the first remaining one becomes the ref, as `guardOpenAir`
 * does. Without one the activity keeps its text and loses the ref. `dropped` counts removed keys.
 */
export function guardStopRefs(a: PlanActivity, day: number, c: StopCtx, place?: string): { act: PlanActivity; dropped: number } {
  if (!a.ref) return { act: a, dropped: 0 };
  const keys = [a.ref, ...(a.alts ?? [])];
  const kept = keys.filter((k) => refAllowed(k, day, c, place)) as OsmKey[];
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
