/** Deterministic checks of the port-places evals (docs/specs/port-places.md section 9). Pure: no network, no model. */
import type { LlmDay, LlmPlan, Plan } from "@/lib/domain/plan";
import type { AssembleIssues } from "@/lib/plan/assemble";
import type { PlanInputStored } from "@/lib/plan/input";
import { placeMatches } from "@/lib/plan/place-match";
import { refAllowed, stopRefCtx } from "@/lib/plan/stop-refs";
import type { StopRow } from "@/lib/plan/stops-input";
import type { CheckResult } from "./checks";

const check = (name: string, ok: boolean, detail?: string): CheckResult => (ok ? { name, ok } : { name, ok, detail });
/** A reported number that never fails (spec: `stop_mismatch` and `port_window_missing` in the raw output are warnings). */
const report = (name: string, n: number): CheckResult => ({ name: `${name} (reported: ${n})`, ok: true });

const rowsOf = (stored: PlanInputStored): StopRow[] => stored.llm.trip.stops ?? [];
const siteRows = (stored: PlanInputStored) => rowsOf(stored).filter((r) => r.place && (r.arr || r.dep));

/**
 * The port windows of the model's own output (before any guard): a stop of the day whose place matches the row has
 * `fixed: true` and the row's times as `from`/`to`.
 */
export function rawPortWindows(llm: LlmPlan, stored: PlanInputStored): CheckResult[] {
  return siteRows(stored).map((r) => {
    const day = llm.days.find((d) => d.n === r.day);
    const stop = day?.stops.find((s) => placeMatches(s.place, r.place!) && (!r.arr || s.from === r.arr) && (!r.dep || s.to === r.dep) && s.fixed === true);
    return check(`raw port window day ${r.day} ${r.place} ${r.arr ?? ""}-${r.dep ?? ""}`, !!stop, day ? day.stops.map((s) => `${s.place} ${s.from ?? ""}-${s.to ?? ""}${s.fixed ? " fixed" : ""}`).join(" | ") : "no day");
  });
}

/** The same windows on the stored plan, after the guard: they must hold whatever the model wrote. */
export function storedPortWindows(plan: Plan, stored: PlanInputStored): CheckResult[] {
  return siteRows(stored).map((r) => {
    const day = plan.days.find((d) => d.n === r.day);
    const stop = day?.stops.find((s) => placeMatches(s.place, r.place!) && (!r.arr || s.from === r.arr) && (!r.dep || s.to === r.dep) && s.fixed === true);
    return check(`stored port window day ${r.day} ${r.place} ${r.arr ?? ""}-${r.dep ?? ""}`, !!stop, day ? day.stops.map((s) => `${s.place} ${s.from ?? ""}-${s.to ?? ""}${s.fixed ? " fixed" : ""}`).join(" | ") : "no day");
  });
}

/** Ids of the model's refs and alts per day (the unguarded view of what it chose). */
export function modelRefs(days: readonly LlmDay[]): { day: number; id: string }[] {
  return days.flatMap((d) => d.stops.flatMap((s) => s.acts.flatMap((a) => [a.ref, ...(a.ref ? (a.alts ?? []) : [])].flatMap((id) => (id ? [{ day: d.n, id }] : [])))));
}

/** Refs and alts of the model that may not be used on their day (what the stop-ref guard will drop). */
export function rawStopMismatches(llm: LlmPlan, stored: PlanInputStored): { day: number; id: string }[] {
  const ctx = stopRefCtx(stored);
  if (!ctx) return [];
  return modelRefs(llm.days).filter(({ day, id }) => {
    const e = stored.index[id];
    return !!e && !refAllowed(e.key, day, ctx);
  });
}

/** Which windows cover lunch (12:00-13:00) or dinner (19:00-20:00): the meals a port visit should plan with a restaurant. */
export function mealWindows(stored: PlanInputStored): { day: number; place: string; at: string; stop: string }[] {
  const out: { day: number; place: string; at: string; stop: string }[] = [];
  for (const r of siteRows(stored)) {
    if (!r.at || r.at === "dest") continue;
    const from = r.arr ?? "00:00";
    const to = r.dep ?? "23:59";
    for (const [at, end] of [["12:00", "13:00"], ["19:00", "20:00"]] as const) if (from <= at && to >= end) out.push({ day: r.day, place: r.place!, at, stop: r.at });
  }
  return out;
}

/**
 * The checks of a Generate with stops, on the model output `llm` and the stored (guarded) plan:
 * port windows raw and stored, every ref on the right day after the guard, no stop place on another day, a food activity
 * with a restaurant of the stop in every lunch or dinner window; the guards' counters of the raw output are reported.
 */
export function stopGenerateChecks(a: { llm: LlmPlan; plan: Plan; stored: PlanInputStored; issues: AssembleIssues }): CheckResult[] {
  const { llm, plan, stored } = a;
  const r: CheckResult[] = [...rawPortWindows(llm, stored), ...storedPortWindows(plan, stored)];
  const ctx = stopRefCtx(stored);
  const keyOf = new Map(Object.entries(stored.index).map(([id, e]) => [id, e.key as string]));
  // After the guard: every ref and alt sits on a day it may be used on.
  const stray: string[] = [];
  const otherDay: string[] = [];
  for (const d of plan.days)
    for (const s of d.stops)
      for (const act of s.acts)
        for (const key of [act.ref, ...(act.ref ? (act.alts ?? []) : [])]) {
          if (!key) continue;
          if (ctx && !refAllowed(key, d.n, ctx)) stray.push(`d${d.n} ${key}`);
          const stop = ctx?.stopOfKey.get(key);
          if (stop && !ctx!.days[stop]?.includes(d.n)) otherDay.push(`d${d.n} ${key} of ${stop}`);
        }
  r.push(check("every ref and alt belongs to its day's stop, or to the destination within 10 km of it", stray.length === 0, stray.slice(0, 5).join(" | ")));
  r.push(check("no stop place appears on another day", otherDay.length === 0, otherDay.slice(0, 5).join(" | ")));
  // Meals: a food activity with a restaurant ref of the stop in each window that covers lunch or dinner.
  const restaurantsOf = (stopId: string) => new Set((stored.llm.stopPlaces?.find((p) => p.id === stopId)?.restaurants?.list ?? []).map((x) => keyOf.get(x.id)));
  for (const w of mealWindows(stored)) {
    const rest = restaurantsOf(w.stop);
    const day = plan.days.find((d) => d.n === w.day);
    const has = !!day?.stops.some((s) => s.acts.some((act) => act.kind === "food" && !!act.ref && rest.has(act.ref)));
    r.push(check(`day ${w.day} ${w.place} ${w.at}: a food activity with a restaurant of the stop`, has || rest.size === 0, `no ref of ${[...rest].slice(0, 3).join(",")}`));
  }
  r.push(report("stop_mismatch in the raw output", rawStopMismatches(llm, stored).length));
  r.push(report("port_window_missing in the stored plan", a.issues.port_window_missing));
  r.push(report("stop_mismatch dropped by the guard", a.issues.stop_mismatch));
  return r;
}

/** Day notes and activity texts of one day (the place the "could not be checked" note may sit). */
const dayProse = (plan: Plan, n: number): string[] => {
  const d = plan.days.find((x) => x.n === n);
  return d ? [d.note ?? "", d.warn ?? "", ...d.stops.flatMap((s) => s.acts.map((a) => a.text))].filter(Boolean) : [];
};

/**
 * Failure case: a stop whose lookups failed. Its day says so once ("Orte in X konnten nicht geprüft werden"), names only that
 * stop, never claims "nothing found"; the stop has no refs; the other stops are unaffected.
 */
export function stopFailureChecks(plan: Plan, stored: PlanInputStored, failedStop: { id: string; name: string; day: number }): CheckResult[] {
  const prose = dayProse(plan, failedStop.day).join(" | ");
  const folded = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const says = folded(prose).includes(folded(failedStop.name)) && /gepr[uü]ft|checked|geladen|loaded|verifi/i.test(folded(prose).replace(/ü/g, "u"));
  const claimsNone = /keine .*gefunden|nothing found|no .* found/i.test(prose);
  const ctx = stopRefCtx(stored);
  const refs = plan.days
    .filter((d) => d.n === failedStop.day)
    .flatMap((d) => d.stops.flatMap((s) => s.acts.flatMap((a) => [a.ref, ...(a.alts ?? [])]).filter((k): k is NonNullable<typeof k> => !!k)))
    .filter((k) => ctx?.stopOfKey.get(k) === failedStop.id);
  return [
    check(`day ${failedStop.day} says the places in ${failedStop.name} could not be checked`, says, prose.slice(0, 200)),
    check(`day ${failedStop.day} does not claim that nothing was found`, !claimsNone, prose.slice(0, 200)),
    check(`day ${failedStop.day} has no ref of the failed stop`, refs.length === 0, refs.join(",")),
    check("the failed stop is marked in the input", stored.llm.stopPlaces?.find((p) => p.id === failedStop.id)?.s === "error" || stored.llm.stopPlaces?.find((p) => p.id === failedStop.id)?.restaurants?.s === "error"),
  ];
}

/**
 * Patch case ("konkrete Restaurantvorschläge für die Tage an Land in anderen Städten" on a plan-7 base): the input was
 * upgraded with the stops, the first answer asked for nothing (no needPlaces, so one model call), and every port day in
 * `days` gained a restaurant ref of its stop.
 */
export function portPatchChecks(a: { upgraded: PlanInputStored; first: { needPlaces?: unknown; days: unknown[] }; base: Plan; next: Plan; portDays: { day: number; stop: string }[] }): CheckResult[] {
  const keyOf = new Map(Object.entries(a.upgraded.index).map(([id, e]) => [id, e.key as string]));
  const r: CheckResult[] = [
    check("the input is upgraded with trip.stops and stopPlaces", !!a.upgraded.llm.trip.stops?.length && !!a.upgraded.llm.stopPlaces?.length),
    check("one model call (no needPlaces)", a.first.needPlaces === undefined),
  ];
  for (const { day, stop } of a.portDays) {
    const rest = new Set((a.upgraded.llm.stopPlaces?.find((p) => p.id === stop)?.restaurants?.list ?? []).map((x) => keyOf.get(x.id)));
    const refs = (p: Plan) => p.days.find((d) => d.n === day)?.stops.flatMap((s) => s.acts.filter((x) => x.kind === "food" && !!x.ref && rest.has(x.ref))).length ?? 0;
    r.push(check(`day ${day} gains a restaurant ref of ${stop}`, refs(a.next) > refs(a.base) || rest.size === 0, `${refs(a.base)} -> ${refs(a.next)}`));
  }
  return r;
}
