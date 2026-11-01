import { MAX_OPEN_ITEMS, isUserBest, type Plan, type PlanActivity, type PlanDay, type PlanEdit } from "@/lib/domain/plan";
import { openItemKey } from "./open-items";
import { diffDays } from "./patch";

/** Day content that moves with a swap; `n` and `date` stay in place. */
function content(d: PlanDay): Omit<PlanDay, "n" | "date"> {
  const { n, date, ...rest } = d;
  void n;
  void date;
  return rest;
}

/** Sets or clears the user's best-day marker; also clears an older AI-set `best` (patch-safety [D8]). */
function withBest(d: PlanDay, best: boolean): PlanDay {
  if (best ? isUserBest(d) : !d.best && !d.bestBy) return d;
  const copy = { ...d };
  if (best) {
    copy.best = true;
    copy.bestBy = "user";
  } else {
    delete copy.best;
    delete copy.bestBy;
  }
  return copy;
}

/** Address of one activity in a plan version (patch-safety [D7]). */
export type ActAddress = { n: number; s: number; a: number };

/** Replaces the activity at `at` with `next(act)` (null = remove). Returns `day` itself when nothing changes. */
function mapAct(day: PlanDay, at: ActAddress, next: (act: PlanActivity) => PlanActivity | null): PlanDay {
  const stop = day.stops[at.s];
  const act = stop?.acts[at.a];
  if (!act) return day;
  const replaced = next(act);
  if (replaced === act) return day;
  const acts = replaced ? stop.acts.map((x, i) => (i === at.a ? replaced : x)) : stop.acts.filter((_, i) => i !== at.a);
  // A stop without activities goes away, unless it is a fixed window or the day's only stop.
  const dropStop = acts.length === 0 && !stop.fixed && day.stops.length > 1;
  const stops = dropStop ? day.stops.filter((_, i) => i !== at.s) : day.stops.map((x, i) => (i === at.s ? { ...x, acts } : x));
  return { ...day, stops };
}

/** Removes one alternative place of an activity. Pure; unknown address or alt → `day` unchanged. */
export function removeAlt(day: PlanDay, at: ActAddress, alt: string): PlanDay {
  return mapAct(day, at, (act) => {
    if (!act.alts?.includes(alt)) return act;
    const alts = act.alts.filter((k) => k !== alt);
    const copy: PlanActivity = { ...act };
    if (alts.length) copy.alts = alts;
    else delete copy.alts;
    return copy;
  });
}

/** Makes an alternative the main place; the old main place becomes that alternative (same slot). */
export function promoteAlt(day: PlanDay, at: ActAddress, alt: string): PlanDay {
  return mapAct(day, at, (act) => {
    if (!act.ref || !act.alts?.includes(alt)) return act;
    const old = act.ref;
    return { ...act, ref: alt as PlanActivity["ref"], alts: act.alts.map((k) => (k === alt ? old : k)) };
  });
}

/** Removes one activity (and its stop when that becomes empty, see mapAct). */
export function removeActivity(day: PlanDay, at: ActAddress): PlanDay {
  return mapAct(day, at, () => null);
}

/** Places still referenced by an activity (ref and alts) of `days`; edits never add places. */
function prunePlaces(days: PlanDay[], places: Plan["places"]): Plan["places"] {
  const used = new Set(days.flatMap((d) => d.stops.flatMap((s) => s.acts.flatMap((a) => (a.ref ? [a.ref, ...(a.alts ?? [])] : [])))));
  return Object.fromEntries(Object.entries(places).filter(([k]) => used.has(k)));
}

type OpenEdit = Extract<PlanEdit, { kind: "open_add" | "open_set" | "open_remove" }>;

/** The list after an edit; `items` itself when nothing changes (unknown index, full list, repeated text). */
function editOpenItems(items: Plan["openItems"], edit: OpenEdit): Plan["openItems"] {
  if (edit.kind === "open_remove") return edit.i < items.length ? items.filter((_, i) => i !== edit.i) : items;
  const key = openItemKey(edit.text);
  if (items.some((o, i) => openItemKey(o.text) === key && (edit.kind === "open_add" || i !== edit.i))) return items;
  if (edit.kind === "open_add") return items.length < MAX_OPEN_ITEMS ? [...items, { text: edit.text }] : items;
  const old = items[edit.i];
  if (!old || old.text === edit.text) return items;
  return items.map((o, i) => (i === edit.i ? { ...o, text: edit.text } : o));
}

/** Code-only edits, no LLM [D8]. Pure; out-of-range days or addresses leave the plan unchanged. */
export function applyEdit(base: Plan, edit: PlanEdit): { plan: Plan; changedDays: number[] } {
  if (edit.kind === "open_add" || edit.kind === "open_set" || edit.kind === "open_remove") {
    const openItems = editOpenItems(base.openItems, edit);
    return { plan: openItems === base.openItems ? base : { ...base, openItems }, changedDays: [] };
  }
  const total = base.days.length;
  let days = base.days;
  if (edit.kind === "swap_days") {
    const { a, b } = edit;
    if (a !== b && a <= total && b <= total) {
      const da = base.days[a - 1];
      const db = base.days[b - 1];
      days = base.days.map((d) => {
        if (d.n === a) return { n: da.n, date: da.date, ...content(db) };
        if (d.n === b) return { n: db.n, date: db.date, ...content(da) };
        return d;
      });
    }
  } else if (edit.kind === "set_best") {
    if (edit.n === null || edit.n <= total) days = base.days.map((d) => withBest(d, d.n === edit.n));
  } else {
    const day = base.days[edit.n - 1];
    if (day) {
      const at = { n: edit.n, s: edit.s, a: edit.a };
      const next =
        edit.kind === "remove_alt"
          ? removeAlt(day, at, edit.alt)
          : edit.kind === "promote_alt"
            ? promoteAlt(day, at, edit.alt)
            : removeActivity(day, at);
      if (next !== day) days = base.days.map((d) => (d === day ? next : d));
    }
  }
  if (days === base.days) return { plan: base, changedDays: [] };
  const plan = edit.kind === "swap_days" || edit.kind === "set_best" ? { ...base, days } : { ...base, days, places: prunePlaces(days, base.places) };
  return { plan, changedDays: diffDays(base.days, days) };
}
