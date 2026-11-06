import type { Locale } from "@/lib/domain/profile";
import {
  HHMM,
  Plan,
  type LlmDay,
  type LlmPlan,
  type OpenItem,
  type OsmKey,
  type PlanActivity,
  type PlanDay,
  type PlanFactsDigest,
  type PlanFlights,
  type PlanHeader,
  type PlanNote,
  type PlanPlace,
  type PlanStop,
} from "@/lib/domain/plan";
import { stripDistances } from "./distance-text";
import { dropOverlaps } from "./fixed-items";
import type { PlanInputStored } from "./input";
import { guardOpenAir, placeClasses, type PlaceClass } from "./open-air";
import { guardScheduleTimes } from "./schedule-times";

export type AssembleIssue =
  | "invalid_ref"
  | "bad_time"
  | "truncated"
  | "extra_best"
  | "window_violation"
  | "fixed_overlap"
  /** Issue #142: arrival/departure time at a scheduled stop that is not in the notes (dropped). */
  | "invented_time"
  /** Issue #142: a prose field that stated a distance (number + unit removed). */
  | "distance_text"
  /** Issue #142: an open-air bath removed from ref/alts of an indoor activity or on a cold day. */
  | "open_air";
export type AssembleIssues = Record<AssembleIssue, number>;

export const LIMITS = {
  title: 60, // prompt asks for <= 40 (plan-5); clamped, never rejected
  place: 80,
  text: 90, // activity text; prompt asks for short phrases <= 50 (plan-5). Stored plans may hold up to 200.
  dayNote: 240,
  stops: 4,
  acts: 12,
  summary: 600,
  notes: 10,
  noteText: 240,
  open: 12,
  openText: 160,
  packing: 15,
  packingText: 80,
} as const;

const ACT_KINDS = new Set(["see", "do", "sport", "food", "rest", "travel", "shop", "free"]);

export const emptyIssues = (): AssembleIssues => ({
  invalid_ref: 0,
  bad_time: 0,
  truncated: 0,
  extra_best: 0,
  window_violation: 0,
  fixed_overlap: 0,
  invented_time: 0,
  distance_text: 0,
  open_air: 0,
});

/** Code guard [D6]: timed activities that overlap a fixed item of their day are dropped and counted. */
export function guardFixed(day: PlanDay, fixed: PlanInputStored["llm"]["fixed"], issues: AssembleIssues): PlanDay {
  const r = dropOverlaps(day, fixed);
  issues.fixed_overlap += r.dropped;
  return r.day;
}

/** Trim, collapse whitespace, cut with "…" at `max` chars; "" → undefined. */
export function clampText(s: string | undefined, max: number, issues: AssembleIssues): string | undefined {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  if (t.length <= max) return t;
  issues.truncated += 1;
  return t.slice(0, max - 1).trimEnd() + "…";
}

/** Model prose (not place names): distances removed (issue #142), then clamped like `clampText`. */
export function proseText(s: string | undefined, max: number, issues: AssembleIssues): string | undefined {
  if (!s) return clampText(s, max, issues);
  const r = stripDistances(s);
  if (r.hit) issues.distance_text += 1;
  return clampText(r.text, max, issues);
}

function time(s: string | undefined, issues: AssembleIssues): string | undefined {
  if (s === undefined || s === "") return undefined;
  const t = s.trim();
  // Accept "7:00" by padding; everything else that is not HH:MM is dropped.
  const padded = /^\d:\d\d$/.test(t) ? `0${t}` : t;
  if (HHMM.safeParse(padded).success) return padded;
  issues.bad_time += 1;
  return undefined;
}

const defined = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
};

/** Is `t` inside [from, to]? Missing bounds are open. */
const inside = (t: string, from?: string, to?: string) => (!from || t >= from) && (!to || t <= to);

/** All HH:MM times written in free text ("7:00", "07:00", "7.00" → "07:00"). */
export function noteTimes(notes: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of (notes ?? "").matchAll(/(?<!\d)(\d{1,2})[:.](\d{2})(?!\d)/g)) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h <= 23 && min <= 59) out.add(`${String(h).padStart(2, "0")}:${m[2]}`);
  }
  return out;
}

export const MAX_ALTS = 2;

/** Index entry for a model-supplied id; own keys only, so "constructor" or "__proto__" never resolve. */
export function indexHit(index: PlanInputStored["index"], id: string): PlanInputStored["index"][string] | undefined {
  const k = String(id).trim();
  return Object.hasOwn(index, k) ? index[k] : undefined;
}

/**
 * Alternative place ids → OSM keys, validated like `ref`: unknown ids are dropped (and counted as invalid_ref),
 * the ref itself and duplicates are skipped, at most MAX_ALTS kept. Alternatives without a valid ref are ignored
 * by the caller.
 */
export function resolveAlts(
  ids: string[] | undefined,
  ref: OsmKey,
  index: PlanInputStored["index"],
  issues: AssembleIssues,
): OsmKey[] | undefined {
  const out: OsmKey[] = [];
  for (const raw of ids ?? []) {
    const hit = indexHit(index, raw);
    if (!hit) {
      issues.invalid_ref += 1;
      continue;
    }
    if (hit.key === ref || out.includes(hit.key)) continue;
    if (out.length < MAX_ALTS) out.push(hit.key);
  }
  return out.length ? out : undefined;
}

export type DayCtx = {
  date: string | null;
  index: PlanInputStored["index"];
  fallbackPlace: string;
  issues: AssembleIssues;
  /** Times from the user's trip notes; a stop stays `fixed` only if all its window times are in here. */
  noteTimes: Set<string>;
  /** Patch only: text of the base day's activity at the same place, used when the model left text empty. */
  baseText?: Map<OsmKey, string>;
  /** The user's trip notes: arrival/departure times at a place they name must come from them (issue #142). */
  notes?: string;
  /** Indoor/outdoor and category per OSM key, for the open-air guard (issue #142). */
  places?: PlaceClass;
  /** Climate months of the input: an open-air pool is out of season below OPEN_AIR_MIN_TMAX. */
  climate?: PlanInputStored["llm"]["climate"];
};

/** The per-plan part of DayCtx that the guards of issue #142 need. */
export function guardCtx(stored: PlanInputStored): Pick<DayCtx, "notes" | "places" | "climate"> {
  return { notes: stored.llm.trip.notes, places: placeClasses(stored), climate: stored.llm.climate };
}

/** One model day → stored day (spec 4.5). The best-day highlight is never model output (patch-safety [D8]). */
export function assembleDay(d: LlmDay, ctx: DayCtx): PlanDay {
  const { issues } = ctx;
  if (d.stops.length > LIMITS.stops) issues.truncated += 1;
  const stops: PlanStop[] = d.stops.slice(0, LIMITS.stops).map((s) => {
    const from = time(s.from, issues);
    const to = time(s.to, issues);
    if (s.acts.length > LIMITS.acts) issues.truncated += 1;
    const acts: PlanActivity[] = [];
    for (const a of s.acts.slice(0, LIMITS.acts)) {
      let ref: OsmKey | undefined;
      let refName: string | undefined;
      if (a.ref) {
        const hit = indexHit(ctx.index, a.ref);
        if (hit) {
          ref = hit.key;
          refName = hit.place.name;
        } else issues.invalid_ref += 1;
      }
      const alts = ref ? resolveAlts(a.alts, ref, ctx.index, issues) : undefined;
      // An empty text with a valid ref falls back to the base day's text for that place, then to the place name
      // (both seen live in patches, spec patch-safety [D6]); else the act is dropped.
      const text =
        proseText(a.text, LIMITS.text, issues) ??
        proseText(ref ? ctx.baseText?.get(ref) : undefined, LIMITS.text, issues) ??
        clampText(refName, LIMITS.text, issues);
      if (!text) continue;
      const at = time(a.at, issues);
      const until = time(a.until, issues);
      if ((from || to) && ((at && !inside(at, from, to)) || (until && !inside(until, from, to)))) {
        issues.window_violation += 1;
      }
      let act = defined({ at, until, kind: ACT_KINDS.has(a.kind) ? a.kind : "do", text, ref, alts }) as PlanActivity;
      if (ctx.places) {
        const g = guardOpenAir(act, ctx.places, ctx.date, ctx.climate);
        issues.open_air += g.dropped;
        act = g.act;
      }
      acts.push(act);
    }
    const place = proseText(s.place, LIMITS.place, issues) ?? ctx.fallbackPlace;
    const sched = guardScheduleTimes(acts, place, ctx.notes, ctx.noteTimes);
    issues.invented_time += sched.dropped;
    return defined({
      place,
      from,
      to,
      // "From your notes" is a claim about user input: only trust it when the user actually wrote both times.
      // A one-sided window ("departs 16:00") is fine; every time it does give must be in the notes.
      fixed:
        s.fixed === true && (from || to) && [from, to].every((t) => !t || ctx.noteTimes.has(t)) ? true : undefined,
      acts: sched.acts,
    });
  });
  const title = proseText(d.title, LIMITS.title, issues) ?? stops[0]?.place ?? ctx.fallbackPlace;
  return defined({
    n: d.n,
    date: ctx.date,
    title,
    stops: stops.length ? stops : [{ place: title.slice(0, LIMITS.place), acts: [] }],
    note: proseText(d.note, LIMITS.dayNote, issues),
    warn: proseText(d.warn, LIMITS.dayNote, issues),
  });
}

/** Keeps the first `best` (in day order), counts the rest. Returns new objects only where changed. */
export function keepOneBest(days: PlanDay[], issues: AssembleIssues, keep?: number): PlanDay[] {
  const winner = keep ?? days.find((d) => d.best)?.n;
  return days.map((d) => {
    if (!d.best || d.n === winner) return d;
    issues.extra_best += 1;
    const copy = { ...d };
    delete copy.best;
    return copy;
  });
}

export function assembleNotes(notes: LlmPlan["notes"], issues: AssembleIssues): PlanNote[] {
  if (notes.length > LIMITS.notes) issues.truncated += 1;
  return notes.slice(0, LIMITS.notes).flatMap((n) => {
    const text = proseText(n.text, LIMITS.noteText, issues);
    return text ? [{ kind: n.kind === "warning" ? "warning" : "tip", text } as PlanNote] : [];
  });
}

export function assembleOpen(open: LlmPlan["open"], days: number, issues: AssembleIssues): OpenItem[] {
  if (open.length > LIMITS.open) issues.truncated += 1;
  return open.slice(0, LIMITS.open).flatMap((o) => {
    const text = proseText(o.text, LIMITS.openText, issues);
    if (!text) return [];
    const day = Number.isInteger(o.day) && o.day! >= 1 && o.day! <= days ? o.day : undefined;
    return [defined({ text, day })];
  });
}

export function assemblePacking(items: string[], issues: AssembleIssues): string[] {
  const out: string[] = [];
  for (const p of items) {
    const t = proseText(p, LIMITS.packingText, issues);
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  if (out.length > LIMITS.packing) issues.truncated += 1;
  return out.slice(0, LIMITS.packing);
}

/** Places referenced by any activity (ref and alts), looked up in `known` (base plan places) then in the index. */
export function referencedPlaces(
  days: PlanDay[],
  index: PlanInputStored["index"],
  known: Record<string, PlanPlace> = {},
): Record<string, PlanPlace> {
  const byKey = new Map<string, PlanPlace>();
  for (const { key, place } of Object.values(index)) byKey.set(key, place);
  const out: Record<string, PlanPlace> = {};
  for (const d of days)
    for (const s of d.stops)
      for (const a of s.acts)
        for (const k of [a.ref, ...(a.ref ? (a.alts ?? []) : [])]) {
          if (!k || out[k]) continue;
          const p = known[k] ?? byKey.get(k);
          if (p) out[k] = p;
        }
  return out;
}

/** True when `n` values are exactly 1..N (after sorting). */
export function exactDayNumbers(ns: number[], total: number): boolean {
  if (ns.length !== total) return false;
  const sorted = [...ns].sort((a, b) => a - b);
  return sorted.every((n, i) => n === i + 1);
}

/** Model output + code facts → stored `Plan` (spec 4.5). Pure. */
export function assemblePlan(a: {
  llm: LlmPlan;
  stored: PlanInputStored;
  header: PlanHeader;
  digest: PlanFactsDigest;
  locale: Locale;
  /** Code snapshot of verified flights (from `buildPlanInput`); never model output. */
  flights?: PlanFlights;
}): { ok: true; plan: Plan; issues: AssembleIssues } | { ok: false; reason: "day_count" | "schema" } {
  const { llm, stored } = a;
  const dayList = stored.llm.dayList;
  if (!exactDayNumbers(llm.days.map((d) => d.n), dayList.length)) return { ok: false, reason: "day_count" };
  const issues = emptyIssues();
  const fallbackPlace = stored.llm.trip.dest.slice(0, LIMITS.place);
  const sorted = [...llm.days].sort((x, y) => x.n - y.n);
  const times = noteTimes(stored.llm.trip.notes);
  const guards = guardCtx(stored);
  const days = sorted.map((d) =>
    guardFixed(
      assembleDay(d, {
        date: dayList[d.n - 1]?.date ?? null,
        index: stored.index,
        fallbackPlace,
        issues,
        noteTimes: times,
        ...guards,
      }),
      stored.llm.fixed,
      issues,
    ),
  );
  const candidate = {
    v: 1 as const,
    locale: a.locale,
    header: a.header,
    summary: proseText(llm.summary, LIMITS.summary, issues) ?? "",
    days,
    notes: assembleNotes(llm.notes, issues),
    openItems: assembleOpen(llm.open, dayList.length, issues),
    packing: assemblePacking(llm.packing, issues),
    places: referencedPlaces(days, stored.index),
    facts: a.digest,
    ...(a.flights ? { flights: a.flights } : {}),
  };
  const parsed = Plan.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: "schema" };
  return { ok: true, plan: parsed.data, issues };
}

