import { Plan, type LlmPatch, type PlanDay, type PlanStop } from "@/lib/domain/plan";
import {
  LIMITS,
  assembleDay,
  assembleNotes,
  assembleOpen,
  clampText,
  emptyIssues,
  guardFixed,
  noteTimes,
  referencedPlaces,
  type AssembleIssues,
} from "./assemble";
import { canonicalJson } from "./hash";
import type { PlanInputStored } from "./input";

/** Day numbers whose content differs between two day lists (same length, same order). */
export function diffDays(base: PlanDay[], next: PlanDay[]): number[] {
  return next.filter((d, i) => canonicalJson(d) !== canonicalJson(base[i])).map((d) => d.n);
}

const sameWindow = (a: PlanStop, b: PlanStop) =>
  a.fixed === true && a.place === b.place && a.from === b.from && a.to === b.to;

/**
 * Fixed windows of the base day survive a patch: a model stop that matches one exactly (place/from/to/fixed) is
 * kept (its acts may change); otherwise the base stop is re-inserted in time order and model stops at the same
 * place are dropped (they are the moved copy). Non-fixed stops are cut from the end to stay within LIMITS.stops.
 */
export function keepFixedStops(baseDay: PlanDay | undefined, next: PlanDay): PlanDay {
  const fixed = baseDay?.stops.filter((s) => s.fixed) ?? [];
  const missing = fixed.filter((f) => !next.stops.some((s) => sameWindow(s, f)));
  if (!missing.length) return next;
  const lower = (s: string) => s.toLowerCase();
  let stops = next.stops.filter((s) => !missing.some((f) => lower(f.place) === lower(s.place)));
  for (const f of missing) {
    const at = stops.findIndex((s) => (s.from ?? s.to ?? "") > (f.from ?? ""));
    stops = at < 0 ? [...stops, f] : [...stops.slice(0, at), f, ...stops.slice(at)];
  }
  while (stops.length > LIMITS.stops) {
    const i = stops.map((s) => !s.fixed).lastIndexOf(true);
    if (i < 0) break;
    stops = stops.filter((_, j) => j !== i);
  }
  return { ...next, stops };
}

/** Place → activity text of a base day (first wins). */
function baseTexts(day: PlanDay | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of day?.stops ?? []) for (const a of s.acts) if (a.ref && !out.has(a.ref)) out.set(a.ref, a.text);
  return out;
}

/**
 * Applies a day patch (spec 4.5). Pure. Unaffected days are the same objects as in `base`;
 * patched days are assembled like in `assemblePlan`. With a non-empty `scope`, patch days outside it are dropped,
 * `summary`/`notes` are ignored and only open items for in-scope days are taken (others stay as in `base`).
 * Reserved and unknown top-level keys (`flights`, `items`, `costs`, …) are carried over verbatim.
 */
export function applyPatch(a: {
  base: Plan;
  patch: LlmPatch;
  stored: PlanInputStored;
  scope: number[];
  /** Current fixed slots (trip items now); defaults to the ones in the stored input. */
  fixed?: PlanInputStored["llm"]["fixed"];
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
  const times = noteTimes(stored.llm.trip.notes);
  const replaced = new Map<number, PlanDay>();
  for (const d of inScope) {
    if (replaced.has(d.n)) continue; // first wins
    const day = assembleDay(d, {
      date: base.days[d.n - 1]?.date ?? null,
      index: stored.index,
      fallbackPlace,
      issues,
      noteTimes: times,
      baseText: baseTexts(base.days[d.n - 1]),
    });
    replaced.set(d.n, guardFixed(keepFixedStops(base.days[d.n - 1], day), "fixed" in a ? a.fixed : stored.llm.fixed, issues));
  }

  // The best-day highlight is the user's (patch-safety [D8]): a patched day keeps the base day's marker.
  for (const [n, d] of replaced) {
    const b = base.days[n - 1];
    if (b?.best) replaced.set(n, { ...d, best: b.best, ...(b.bestBy ? { bestBy: b.bestBy } : {}) });
  }

  const days = base.days.map((d) => replaced.get(d.n) ?? d);
  const scoped = scope.length > 0;
  let openItems = base.openItems;
  // An empty list never means "remove all" here: the model returned [] for "unchanged" live (plan-4, [D5]).
  if (patch.open !== undefined && patch.open.length > 0) {
    const items = assembleOpen(patch.open, total, issues);
    // Day-scoped: replace open items of in-scope days only; trip-wide and other days' items stay untouched.
    openItems = scoped
      ? [
          ...base.openItems.filter((o) => o.day === undefined || !scope.includes(o.day)),
          ...items.filter((o) => o.day !== undefined && scope.includes(o.day)),
        ]
      : items;
  }
  const next: Plan = {
    ...base,
    days,
    places: referencedPlaces(days, stored.index, base.places),
    summary:
      !scoped && patch.summary !== undefined
        ? (clampText(patch.summary, LIMITS.summary, issues) ?? base.summary)
        : base.summary,
    notes: !scoped && patch.notes !== undefined && patch.notes.length > 0 ? assembleNotes(patch.notes, issues) : base.notes,
    openItems,
  };
  if (!Plan.safeParse(next).success) return { ok: false, reason: "schema" };
  return { ok: true, plan: next, changedDays: diffDays(base.days, days), issues };
}
