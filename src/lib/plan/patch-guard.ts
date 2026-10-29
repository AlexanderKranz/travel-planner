import type { Plan, PlanDay, PlanFeedback } from "@/lib/domain/plan";
import { emptyIssues, keepOneBest, referencedPlaces } from "./assemble";
import type { PlanInputStored } from "./input";
import { diffDays } from "./patch";

/**
 * Code guard after `applyPatch` (spec docs/specs/patch-safety.md). Pure.
 * - [D3] A patched day that lost more than half of its activities (or all of them) is replaced by the base day,
 *   unless the feedback asked to redo or empty that day.
 * - [D4] A day note/warn present in the base day and missing in the patched day is kept, unless the feedback
 *   mentions tips/warnings or asks to redo the day.
 */

export const actCount = (d: PlanDay) => d.stops.reduce((n, s) => n + s.acts.length, 0);

/** Did the patch lose too many activities? Days with fewer than 2 activities can only shrink to 0. */
export function isShrunk(before: number, after: number): boolean {
  if (before === 0) return false;
  if (after === 0) return true;
  return before - after > before / 2;
}

// Free text that clearly asks to remove most of a day (de + en). Kept narrow: "streichen" alone is not enough,
// Alex's live case used it for alternatives.
const EMPTY_DAY_RE =
  /\b(alles|alle aktivit\w*|komplett|ganze[nr]? tag|tag frei|freie[nr]? tag|ruhetag|leer(en)?|nichts|nur noch|neu (gestalten|planen)|everything|all activities|whole day|entire day|day off|free day|rest day|empty|clear (the )?day|nothing|only keep|start over|from scratch)\b/i;
const NOTE_RE = /\b(tipp?s?|hinweis\w*|notiz\w*|note|hint|warn\w*|risiko|risk)\b/i;

/** Does the feedback allow day `n` to shrink: chip "redo_day" for that day, or text asking to clear most of it. */
export function allowsShrink(feedback: PlanFeedback, n: number): boolean {
  const scoped = feedback.days.length === 0 || feedback.days.includes(n);
  if (feedback.chips.includes("redo_day") && scoped) return true;
  return !!feedback.text && EMPTY_DAY_RE.test(feedback.text);
}

/** Does the feedback allow dropping a day's note/warn? */
export function allowsNoteDrop(feedback: PlanFeedback, n: number): boolean {
  const scoped = feedback.days.length === 0 || feedback.days.includes(n);
  if (feedback.chips.includes("redo_day") && scoped) return true;
  return !!feedback.text && NOTE_RE.test(feedback.text);
}

export type ShrinkInfo = { n: number; before: number; after: number };

export function guardPatch(a: {
  base: Plan;
  next: Plan;
  feedback: PlanFeedback;
  index: PlanInputStored["index"];
}): { plan: Plan; changedDays: number[]; rejected: ShrinkInfo[]; keptNotes: number[] } {
  const { base, next, feedback } = a;
  const rejected: ShrinkInfo[] = [];
  const keptNotes: number[] = [];
  let days = next.days.map((d, i) => {
    const b = base.days[i];
    if (!b || d === b) return d;
    const before = actCount(b);
    const after = actCount(d);
    if (isShrunk(before, after) && !allowsShrink(feedback, d.n)) {
      rejected.push({ n: d.n, before, after });
      return b;
    }
    if (allowsNoteDrop(feedback, d.n)) return d;
    const missingNote = !!b.note && !d.note;
    const missingWarn = !!b.warn && !d.warn;
    if (!missingNote && !missingWarn) return d;
    keptNotes.push(d.n);
    return { ...d, ...(missingNote ? { note: b.note } : {}), ...(missingWarn ? { warn: b.warn } : {}) };
  });
  if (!rejected.length && !keptNotes.length) {
    return { plan: next, changedDays: diffDays(base.days, next.days), rejected, keptNotes };
  }
  // A reverted day keeps its own best badge; keepOneBest drops a second one a patched day may have claimed.
  const revertedBest = rejected.find((r) => base.days[r.n - 1]?.best)?.n;
  days = keepOneBest(days, emptyIssues(), revertedBest);
  const plan: Plan = { ...next, days, places: referencedPlaces(days, a.index, { ...base.places, ...next.places }) };
  return { plan, changedDays: diffDays(base.days, days), rejected, keptNotes };
}
