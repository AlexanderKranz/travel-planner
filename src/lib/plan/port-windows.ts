/**
 * Port-window guard (itinerary-upload section 5, port-places section 3): a stop row of `trip.stops` with an arrival or
 * departure time fixes the plan stop of that day that matches its place: `fixed` + `from`/`to` from the row, never from
 * the model. A row without a matching plan stop counts as `port_window_missing`. Pure.
 */
import type { PlanActivity, PlanStop } from "@/lib/domain/plan";
import { placeMatches } from "./place-match";
import type { StopRow } from "./stops-input";

/** The rows of one day that carry a time. */
export const windowRows = (rows: readonly StopRow[] | undefined): StopRow[] => (rows ?? []).filter((r) => r.place && (r.arr || r.dep));

/** Is `t` inside the window? A window whose end is before its start runs past midnight. Missing bounds are open. */
function inWindow(t: string, from?: string, to?: string): boolean {
  if (from && to && to < from) return t >= from || t <= to;
  return (!from || t >= from) && (!to || t <= to);
}

/**
 * Times of activities outside the final window are removed (the activity stays): like `guardScheduleTimes`, code never
 * keeps a time it cannot stand behind and never invents a replacement (clamping would invent one). An `until` outside
 * goes alone; a `at` outside takes its `until` with it. Returns the activities and how many lost a time.
 */
function dropOutside(acts: PlanActivity[], from?: string, to?: string): { acts: PlanActivity[]; dropped: number } {
  let dropped = 0;
  const out = acts.map((a) => {
    const badAt = !!a.at && !inWindow(a.at, from, to);
    const badUntil = !!a.until && !inWindow(a.until, from, to);
    if (!badAt && !badUntil) return a;
    dropped += 1;
    const copy = { ...a };
    delete copy.until;
    if (badAt) delete copy.at;
    return copy;
  });
  return { acts: out, dropped };
}

/**
 * Applies the day's port windows to its stops (new objects only where changed). `missing` = rows no stop matched;
 * `clipped` = activities that lost a time because it lies outside the window now set.
 * Each plan stop takes at most one row, and a row is used once.
 */
export function applyPortWindows(
  stops: PlanStop[],
  rows: readonly StopRow[] | undefined,
): { stops: PlanStop[]; missing: number; clipped: number } {
  const wanted = windowRows(rows);
  if (!wanted.length) return { stops, missing: 0, clipped: 0 };
  const used = new Set<number>();
  let missing = 0;
  let clipped = 0;
  const out = [...stops];
  for (const row of wanted) {
    const at = out.findIndex((s, i) => !used.has(i) && placeMatches(s.place, row.place!));
    if (at < 0) {
      missing += 1;
      continue;
    }
    used.add(at);
    const s = out[at];
    const next: PlanStop = { ...s, fixed: true };
    if (row.arr) next.from = row.arr;
    else delete next.from;
    if (row.dep) next.to = row.dep;
    else delete next.to;
    const r = dropOutside(next.acts, next.from, next.to);
    clipped += r.dropped;
    next.acts = r.acts;
    out[at] = next;
  }
  return { stops: out, missing, clipped };
}

/** Rows of a day that carry a time and name the plan stop `place`: the times that belong to that stop. */
export const rowsOfPlace = (rows: readonly StopRow[] | undefined, place: string): StopRow[] =>
  windowRows(rows).filter((r) => placeMatches(place, r.place!));

/** Every arrival and departure time of the rows (they count as "from your input" next to the notes' times). */
export function rowTimes(rows: readonly StopRow[] | undefined): string[] {
  return (rows ?? []).flatMap((r) => [r.arr, r.dep].filter((t): t is string => !!t));
}
