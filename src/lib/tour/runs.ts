/**
 * Legs, per-leg overrides and runs (docs/specs/city-tour.md sections 3.2 [T7] and 5.3 [T8]). Pure.
 */
import { legKey, type LegSetting, type RouteOption, type TourMode } from "@/lib/domain/tour";

export type PlannedLeg = { from: string; to: string; mode: TourMode; route: RouteOption };
/** Consecutive legs with equal mode and route: one Directions request over `points`. */
export type Run = { mode: TourMode; route: RouteOption; legs: number[]; points: string[] };
type Overrides = Record<string, LegSetting>;

/** Legs of an ordered key sequence with the tour default or the override of that place pair. */
export function plannedLegs(order: readonly string[], defaults: LegSetting, overrides: Overrides = {}): PlannedLeg[] {
  const legs: PlannedLeg[] = [];
  for (let i = 0; i + 1 < order.length; i++) {
    const from = order[i];
    const to = order[i + 1];
    const o = overrides[legKey(from, to)] ?? defaults;
    legs.push({ from, to, mode: o.mode, route: o.route });
  }
  return legs;
}

export function groupRuns(legs: readonly PlannedLeg[]): Run[] {
  const runs: Run[] = [];
  legs.forEach((l, i) => {
    const last = runs.at(-1);
    if (last && last.mode === l.mode && last.route === l.route) {
      last.legs.push(i);
      last.points.push(l.to);
    } else runs.push({ mode: l.mode, route: l.route, legs: [i], points: [l.from, l.to] });
  });
  return runs;
}

/**
 * Overrides after a re-order: one survives while its two places stay neighbours. A pair now travelled the other way
 * keeps its setting under the new direction's key (mode and route options do not depend on direction). Returns the
 * surviving overrides and how many were dropped (for the one-time notice).
 */
export function pruneOverrides(overrides: Overrides, order: readonly string[]): { kept: Overrides; dropped: number } {
  const kept: Overrides = {};
  let dropped = 0;
  const pairs = new Set<string>();
  for (let i = 0; i + 1 < order.length; i++) pairs.add(legKey(order[i], order[i + 1]));
  for (const [k, v] of Object.entries(overrides)) {
    const sep = k.indexOf(">");
    const from = k.slice(0, sep);
    const to = k.slice(sep + 1);
    if (sep > 0 && pairs.has(k)) kept[k] = v;
    else if (sep > 0 && pairs.has(legKey(to, from)) && !overrides[legKey(to, from)]) kept[legKey(to, from)] = v;
    else dropped++;
  }
  return { kept, dropped };
}
