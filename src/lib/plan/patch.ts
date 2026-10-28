import { Plan, type LlmPatch, type PlanDay } from "@/lib/domain/plan";
import {
  LIMITS,
  assembleDay,
  assembleNotes,
  assembleOpen,
  clampText,
  emptyIssues,
  referencedPlaces,
  type AssembleIssues,
} from "./assemble";
import { canonicalJson } from "./hash";
import type { PlanInputStored } from "./input";

/** Day numbers whose content differs between two day lists (same length, same order). */
export function diffDays(base: PlanDay[], next: PlanDay[]): number[] {
  return next.filter((d, i) => canonicalJson(d) !== canonicalJson(base[i])).map((d) => d.n);
}

/**
 * Applies a day patch (spec 4.5). Pure. Unaffected days are the same objects as in `base`;
 * patched days are assembled like in `assemblePlan`. With a non-empty `scope`, patch days outside it are dropped.
 * Reserved and unknown top-level keys (`flights`, `items`, `costs`, …) are carried over verbatim.
 */
export function applyPatch(a: {
  base: Plan;
  patch: LlmPatch;
  stored: PlanInputStored;
  scope: number[];
}):
  | { ok: true; plan: Plan; changedDays: number[]; issues: AssembleIssues }
  | { ok: false; reason: "day_count" | "schema" | "out_of_scope_only" } {
  const { base, patch, stored, scope } = a;
  const total = base.days.length;
  if (patch.days.some((d) => !Number.isInteger(d.n) || d.n < 1 || d.n > total)) return { ok: false, reason: "day_count" };
  const inScope = scope.length ? patch.days.filter((d) => scope.includes(d.n)) : patch.days;
  if (patch.days.length > 0 && inScope.length === 0) return { ok: false, reason: "out_of_scope_only" };

  const issues = emptyIssues();
  const fallbackPlace = stored.llm.trip.dest.slice(0, LIMITS.place);
  const replaced = new Map<number, PlanDay>();
  for (const d of inScope) {
    if (replaced.has(d.n)) continue; // first wins
    replaced.set(
      d.n,
      assembleDay(d, { date: base.days[d.n - 1]?.date ?? null, index: stored.index, fallbackPlace, issues }),
    );
  }

  // At most one best: an untouched base day keeps its badge; otherwise the first patched day that claims it.
  const baseBest = base.days.find((d) => d.best && !replaced.has(d.n))?.n;
  let winner = baseBest;
  for (const n of [...replaced.keys()].sort((x, y) => x - y)) {
    const d = replaced.get(n)!;
    if (!d.best) continue;
    if (winner === undefined) winner = n;
    else if (winner !== n) {
      issues.extra_best += 1;
      const copy = { ...d };
      delete copy.best;
      replaced.set(n, copy);
    }
  }

  const days = base.days.map((d) => replaced.get(d.n) ?? d);
  const next: Plan = {
    ...base,
    days,
    places: referencedPlaces(days, stored.index, base.places),
    summary: patch.summary !== undefined ? (clampText(patch.summary, LIMITS.summary, issues) ?? base.summary) : base.summary,
    notes: patch.notes !== undefined ? assembleNotes(patch.notes, issues) : base.notes,
    openItems: patch.open !== undefined ? assembleOpen(patch.open, total, issues) : base.openItems,
  };
  if (!Plan.safeParse(next).success) return { ok: false, reason: "schema" };
  return { ok: true, plan: next, changedDays: diffDays(base.days, days), issues };
}
