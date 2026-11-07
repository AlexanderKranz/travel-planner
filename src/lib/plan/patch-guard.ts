import type { Plan, PlanDay, PlanFeedback } from "@/lib/domain/plan";
import { emptyIssues, keepOneBest, referencedPlaces } from "./assemble";
import type { PlanInputStored } from "./input";
import { diffDays } from "./patch";

/**
 * Code guard after `applyPatch` (spec docs/specs/patch-safety.md). Pure.
 * - [D3] A patched day that lost more than half of its activities (or all of them) is replaced by the base day,
 *   unless the feedback asked to redo or empty that day, or added activities at verified places took the time of the
 *   dropped ones (`lostActs`).
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

type Act = PlanDay["stops"][number]["acts"][number];
const acts = (d: PlanDay): Act[] => d.stops.flatMap((s) => s.acts);
const sameAct = (a: Act, b: Act) => a.kind === b.kind && (a.ref ? a.ref === b.ref : a.text === b.text);
// Kinds of an added activity that can take over the time of others. free/rest/travel never do (one long "free time"
// in place of a full day is the incomplete answer D3 exists for), and neither does food (a meal replaces no programme).
const REPLACING = new Set<Act["kind"]>(["see", "do", "sport", "shop"]);
/** Longest window of a replacing activity: an 18-hole round with drive and a break fits, a whole-day blanket not. */
export const MAX_REPLACING_MIN = 6 * 60;
/** Base activities one added activity may replace at most. */
export const MAX_REPLACED_PER_ACT = 3;
/** A replaced activity may end this much after the added one (rounded plans: lunch until 14:00, round until 13:45). */
const END_SLACK_MIN = 30;

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Base activities the patched day dropped without a replacement (issue #158). Pure.
 * - Kept: the patched day has the same activity (kind + ref, or kind + text).
 * - Replaced: an activity the patch added (kind see/do/sport/shop, a ref to a verified place in `verified`, at and
 *   until with a window of at most MAX_REPLACING_MIN) covers it: it starts at or after the window start, before its
 *   end (until is exclusive), and ends (its until, else its at) at most END_SLACK_MIN after it. One added activity
 *   replaces at most MAX_REPLACED_PER_ACT base activities, in time order.
 * - Always lost when dropped: activities without at, and activities of a fixed stop (port call, booked window).
 */
export function lostActs(base: PlanDay, next: PlanDay, verified: ReadonlySet<string>): number {
  const after = acts(next);
  const before = acts(base);
  const added = after
    .filter((a) => REPLACING.has(a.kind) && !!a.ref && verified.has(a.ref) && !before.some((b) => sameAct(b, a)))
    .flatMap((a) => {
      if (!a.at || !a.until) return [];
      const from = toMin(a.at);
      const to = toMin(a.until);
      return to > from && to - from <= MAX_REPLACING_MIN ? [{ from, to, left: MAX_REPLACED_PER_ACT }] : [];
    });
  const dropped = base.stops
    .flatMap((s) => s.acts.map((act) => ({ act, fixed: s.fixed === true })))
    .filter(({ act }) => !after.some((a) => sameAct(act, a)));
  let lost = 0;
  for (const { act, fixed } of dropped.sort((x, y) => (x.act.at ?? "99").localeCompare(y.act.at ?? "99"))) {
    const at = act.at ? toMin(act.at) : null;
    const end = act.until ? toMin(act.until) : at;
    const w = fixed || at === null || end === null ? undefined : added.find((x) => x.left > 0 && x.from <= at && at < x.to && end <= x.to + END_SLACK_MIN);
    if (w) w.left -= 1;
    else lost += 1;
  }
  return lost;
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
  // Places of the (extended) input: only these can stand in for dropped activities.
  const verified = new Set<string>(Object.values(a.index).map((e) => e.key));
  let days = next.days.map((d, i) => {
    const b = base.days[i];
    if (!b || d === b) return d;
    const before = actCount(b);
    const after = actCount(d);
    // A day where added activities took the time of the dropped ones (a requested golf round) is not incomplete.
    if (isShrunk(before, after) && isShrunk(before, before - lostActs(b, d, verified)) && !allowsShrink(feedback, d.n)) {
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
