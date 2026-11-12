import type { Plan } from "@/lib/domain/plan";
import { referencedPlaces } from "./assemble";
import type { PlanInputStored } from "./input";
import { guardTourDuplicates, tourStopsByDay } from "./tour-guard";

/**
 * The duplicate guard (city-tour 10) on a stored plan, for a version reused by the input-hash dedupe: an untimed tour
 * does not change the model input, so a plan generated before the tour was linked can come back from the cache.
 * Code only, no AI call. Returns the same plan object when nothing is removed.
 */
export function guardPlanTours(
  plan: Plan,
  tourStops: PlanInputStored["tourStops"],
  index: PlanInputStored["index"],
): { plan: Plan; dropped: number } {
  const byDay = tourStopsByDay(tourStops);
  if (!byDay) return { plan, dropped: 0 };
  const names = new Map(Object.entries(plan.places).map(([k, p]) => [k, p.name]));
  let dropped = 0;
  const days = plan.days.map((d) => {
    const stops = byDay.get(d.n);
    if (!stops) return d;
    let changed = false;
    const next = d.stops.map((s) => {
      const acts = s.acts.flatMap((a) => {
        const g = guardTourDuplicates(a, stops, names);
        dropped += g.dropped;
        if (g.act !== a) changed = true;
        return g.act ? [g.act] : [];
      });
      return acts.length === s.acts.length && acts.every((a, i) => a === s.acts[i]) ? s : { ...s, acts };
    });
    return changed ? { ...d, stops: next } : d;
  });
  if (!dropped) return { plan, dropped: 0 };
  return { plan: { ...plan, days, places: referencedPlaces(days, index, plan.places) }, dropped };
}
