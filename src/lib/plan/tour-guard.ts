import type { OsmKey, PlanActivity } from "@/lib/domain/plan";
import type { PlanInputStored } from "./input";
import { rewriteRemovedName } from "./open-air";

/**
 * Duplicate guard of city tours (docs/specs/city-tour.md section 10 [T16]). Pure.
 * A plan activity on a day whose ref is a stop of that day's tour is replaced by its first alternative that is no tour
 * stop, or dropped: the tour block already shows the place on that day. Alternatives that are tour stops are removed.
 */

/** OSM stops of the tours by trip day, from `PlanInputStored.tourStops`. */
export function tourStopsByDay(stops: PlanInputStored["tourStops"]): Map<number, Set<string>> | undefined {
  if (!stops) return undefined;
  const out = new Map<number, Set<string>>();
  for (const [day, keys] of Object.entries(stops)) if (keys.length) out.set(Number(day), new Set(keys));
  return out.size ? out : undefined;
}

/**
 * `act` null = dropped (its ref was a tour stop and no alternative is left). `dropped` counts removed keys. The text
 * names the new ref instead of the old one when the ref was swapped (as the open-air guard does).
 */
export function guardTourDuplicates(
  a: PlanActivity,
  stops: ReadonlySet<string> | undefined,
  names: ReadonlyMap<string, string> = new Map(),
): { act: PlanActivity | null; dropped: number } {
  if (!a.ref || !stops?.size) return { act: a, dropped: 0 };
  const keys = [a.ref, ...(a.alts ?? [])];
  const kept = keys.filter((k) => !stops.has(k)) as OsmKey[];
  const dropped = keys.length - kept.length;
  if (!dropped) return { act: a, dropped: 0 };
  if (stops.has(a.ref) && !kept.length) return { act: null, dropped };
  const act: PlanActivity = { ...a };
  delete act.alts;
  act.ref = kept[0];
  if (kept.length > 1) act.alts = kept.slice(1);
  if (act.ref !== a.ref) {
    const old = names.get(a.ref);
    const next = names.get(act.ref);
    if (old) act.text = rewriteRemovedName(act.text, old, next) || act.text;
  }
  return { act, dropped };
}
