/**
 * Port-window guard (itinerary-upload section 5, port-places section 3): a stop row of `trip.stops` with an arrival or
 * departure time fixes the plan stop of that day that matches its place: `fixed` + `from`/`to` from the row, never from
 * the model. A row without a matching plan stop counts as `port_window_missing`. Pure.
 */
import type { PlanStop } from "@/lib/domain/plan";
import { placeMatches } from "./place-match";
import type { StopRow } from "./stops-input";

/** The rows of one day that carry a time. */
export const windowRows = (rows: readonly StopRow[] | undefined): StopRow[] => (rows ?? []).filter((r) => r.place && (r.arr || r.dep));

/**
 * Applies the day's port windows to its stops (new objects only where changed). `missing` = rows no stop matched.
 * Each plan stop takes at most one row, and a row is used once.
 */
export function applyPortWindows(stops: PlanStop[], rows: readonly StopRow[] | undefined): { stops: PlanStop[]; missing: number } {
  const wanted = windowRows(rows);
  if (!wanted.length) return { stops, missing: 0 };
  const used = new Set<number>();
  let missing = 0;
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
    out[at] = next;
  }
  return { stops: out, missing };
}

/** Every arrival and departure time of the rows (they count as "from your input" next to the notes' times). */
export function rowTimes(rows: readonly StopRow[] | undefined): string[] {
  return (rows ?? []).flatMap((r) => [r.arr, r.dep].filter((t): t is string => !!t));
}
