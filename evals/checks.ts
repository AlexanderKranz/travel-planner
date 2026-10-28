/** Deterministic eval checks (spec 7). Pure: no network, no model. */
import type { LlmPlan, Plan, PlanDay, PurposeTags } from "@/lib/domain/plan";
import type { AssembleIssues } from "@/lib/plan/assemble";
import { addDays } from "@/lib/facts/trip-timing";
import { canonicalJson } from "@/lib/plan/hash";
import type { PlanInputStored } from "@/lib/plan/input";
import type { EvalFixture, FixtureId, ScheduleEntry } from "./build-input";

export type CheckResult = { name: string; ok: boolean; detail?: string };

const GOLF_CAT = "leisure=golf_course";
const FLIGHT_NO = /\b[A-Z]{2}\s?\d{2,4}\b/;
const MONEY = /[€$£]|\bEUR\b|\bUSD\b/;
const HOURS_RANGE = /\d{1,2}[:.]\d{2}\s*[–-]\s*\d{1,2}[:.]\d{2}/;

const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss").trim();
const isHhmm = (s: string | undefined): s is string => !!s && /^\d\d:\d\d$/.test(s);
const check = (name: string, ok: boolean, detail?: string): CheckResult => (ok ? { name, ok } : { name, ok, detail });

/** Every prose string of a plan (titles, places, activity texts, notes, open items, packing). */
export function proseOf(plan: Plan): string[] {
  const out: string[] = [plan.summary];
  for (const d of plan.days) {
    out.push(d.title);
    if (d.note) out.push(d.note);
    if (d.warn) out.push(d.warn);
    for (const s of d.stops) {
      out.push(s.place);
      for (const a of s.acts) out.push(a.text);
    }
  }
  for (const n of plan.notes) out.push(n.text);
  for (const o of plan.openItems) out.push(o.text);
  out.push(...plan.packing);
  return out;
}

const golfRefs = (plan: Plan, d: PlanDay) =>
  d.stops.flatMap((s) => s.acts.filter((a) => a.kind === "sport" && a.ref && plan.places[a.ref]?.category === GOLF_CAT));

/** Checks for every fixture: structure, refs, invented facts, best day. */
export function genericChecks(a: {
  plan: Plan;
  stored: PlanInputStored;
  rawRefs: string[];
  issues?: AssembleIssues;
  startDate?: string;
  /** Expected presence of plan.flights. */
  flightsRecorded?: boolean;
}): CheckResult[] {
  const { plan, stored } = a;
  const N = stored.llm.dayList.length;
  const r: CheckResult[] = [];
  r.push(check("day count = trip length", plan.days.length === N, `${plan.days.length} vs ${N}`));
  r.push(check("n = 1..N", plan.days.every((d, i) => d.n === i + 1)));
  if (a.startDate) {
    const bad = plan.days.filter((d) => d.date !== addDays(a.startDate!, d.n - 1)).map((d) => d.n);
    r.push(check("dates = start + n - 1", bad.length === 0, `days ${bad.join(",")}`));
  }
  const unknown = a.rawRefs.filter((ref) => !stored.index[ref]);
  r.push(check("every ref is an input place id", unknown.length === 0, unknown.join(",")));
  if (a.issues) r.push(check("invalid_ref = 0", a.issues.invalid_ref === 0, String(a.issues.invalid_ref)));
  const prose = proseOf(plan);
  for (const [name, re] of [
    ["no flight numbers", FLIGHT_NO],
    ["no prices", MONEY],
    ["no opening-hours ranges", HOURS_RANGE],
  ] as const) {
    const hits = prose.filter((t) => re.test(t));
    r.push(check(name, hits.length === 0, hits.slice(0, 3).join(" | ")));
  }
  const reserved = (["items", "costs"] as const).filter((k) => k in plan);
  r.push(check("no items/costs", reserved.length === 0, reserved.join(",")));
  // plan.flights is filled by code from verified facts: present iff the trip wants flights and the fixture records them.
  if (a.flightsRecorded !== undefined) {
    r.push(check("plan.flights iff flights wanted", (plan.flights !== undefined) === a.flightsRecorded, `flights ${plan.flights ? "present" : "absent"}`));
  }
  r.push(check("at most one best day", plan.days.filter((d) => d.best).length <= 1));
  return r;
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Flights: verified outbound leg, proxy label, and (only for a fresh recording) day 1 starts after arrival + 90 min. */
export function flightChecks(plan: Plan, fresh: boolean): CheckResult[] {
  const f = plan.flights;
  if (!f) return [check("plan.flights present", false)];
  const outs = f.legs.filter((l) => l.dir === "out" && l.from === "FRA" && l.to === "AGP" && !l.tooLong && l.blockMin <= 180);
  const r = [
    check("flights: out FRA-AGP leg <= 3 h, not tooLong", outs.length > 0, f.legs.map((l) => `${l.from}${l.to}${l.blockMin}`).join(",")),
    check("flights: mode proxy (2038 is beyond the horizon)", f.mode.out === "proxy" && f.mode.back === "proxy"),
  ];
  if (fresh && outs.length) {
    const earliest = Math.min(...outs.map((l) => toMin(l.arr)));
    const first = plan.days[0]?.stops.flatMap((s) => s.acts.map((a) => a.at)).filter(isHhmm).sort()[0];
    r.push(check("day 1 first activity >= earliest arrival + 90 min", !first || toMin(first) >= earliest + 90, `first ${first}, arrival ${Math.min(...outs.map((l) => toMin(l.arr)))}`));
  }
  return r;
}

export function golfChecks(plan: Plan, c: EvalFixture["checks"], fresh = true): CheckResult[] {
  const r: CheckResult[] = [...flightChecks(plan, fresh)];
  if (c.sportEveryDay) {
    const missing = plan.days.filter((d) => golfRefs(plan, d).length === 0).map((d) => d.n);
    r.push(check("golf round with course ref on every day", missing.length === 0, `missing days ${missing.join(",")}`));
  }
  if (c.twoRoundsOnOneDay) {
    const counts = plan.days.map((d) => golfRefs(plan, d).length);
    const middle = counts.slice(1, -1);
    r.push(check(">= 2 rounds on one day (not arrival/departure)", middle.some((n) => n >= 2), `rounds per day ${counts.join(",")}`));
  }
  for (const n of c.airportNearDays ?? []) {
    const d = plan.days[n - 1];
    const kms = d ? golfRefs(plan, d).map((a) => plan.places[a.ref!]?.airportKm ?? Infinity) : [];
    const ok = kms.length > 0 && kms.every((km) => km <= (c.airportMaxKm ?? 50));
    r.push(check(`day ${n} courses within ${c.airportMaxKm} km of the airport`, ok, `km ${kms.join(",")}`));
  }
  return r;
}

function placeMatches(stopPlace: string, wanted: string): boolean {
  const a = fold(stopPlace);
  const b = fold(wanted);
  return a.includes(b) || b.includes(a);
}

export function cruiseChecks(plan: Plan, c: EvalFixture["checks"], schedule: ScheduleEntry[]): CheckResult[] {
  const r: CheckResult[] = [];
  if (c.restWindow) {
    const [from, to] = c.restWindow;
    const missing = plan.days
      .filter((d) => !(c.restExceptDays ?? []).includes(d.n))
      .filter((d) => !d.stops.some((s) => s.acts.some((a) => a.kind === "rest" && a.at && a.at >= from && a.at <= to)))
      .map((d) => d.n);
    r.push(check(`rest block ${from}-${to} on every day except arrival`, missing.length === 0, `missing days ${missing.join(",")}`));
  }
  if (c.portWindows) {
    for (const e of schedule) {
      const day = plan.days.find((d) => d.date === e.date);
      const timed = isHhmm(e.arrive) || isHhmm(e.depart);
      const stop = day?.stops.find(
        (s) =>
          placeMatches(s.place, e.place) &&
          (!isHhmm(e.arrive) || s.from === e.arrive) &&
          (!isHhmm(e.depart) || s.to === e.depart) &&
          (!timed || s.fixed === true),
      );
      const label = `port window ${e.date} ${e.place} ${e.arrive ?? ""}-${e.depart ?? ""}`;
      r.push(check(label, !!stop, day ? day.stops.map((s) => `${s.place} ${s.from ?? ""}-${s.to ?? ""}${s.fixed ? " fixed" : ""}`).join(" | ") : "no day"));
    }
  }
  const outside: string[] = [];
  for (const d of plan.days)
    for (const s of d.stops) {
      if (!s.from && !s.to) continue;
      for (const a of s.acts)
        for (const t of [a.at, a.until])
          if (t && ((s.from && t < s.from) || (s.to && t > s.to))) outside.push(`d${d.n} ${s.place} ${t}`);
    }
  r.push(check("every activity inside its stop window", outside.length === 0, outside.slice(0, 5).join(" | ")));
  return r;
}

export function tagChecks(id: FixtureId, tags: PurposeTags): CheckResult[] {
  if (id === "golf") {
    return [
      check("tags: interests contain golf", tags.interests.includes("golf"), tags.interests.join(",")),
      check("tags: >= 3 hard constraints", tags.hard.length >= 3, String(tags.hard.length)),
    ];
  }
  return [check("tags: interests contain christmas_markets", tags.interests.includes("christmas_markets"), tags.interests.join(","))];
}

export function planChecks(id: FixtureId, fixture: EvalFixture, plan: Plan, fresh = true): CheckResult[] {
  return id === "golf" ? golfChecks(plan, fixture.checks, fresh) : cruiseChecks(plan, fixture.checks, fixture.fixedSchedule ?? []);
}

export function patchChecks(a: {
  id: FixtureId;
  base: Plan;
  next: Plan;
  changedDays: number[];
  scope: number[];
}): CheckResult[] {
  const { base, next, scope } = a;
  const r: CheckResult[] = [];
  const outside = next.days.filter((d, i) => !scope.includes(d.n) && canonicalJson(d) !== canonicalJson(base.days[i])).map((d) => d.n);
  r.push(check("only scoped days change", outside.length === 0, `changed outside: ${outside.join(",")}`));
  r.push(check("patch changed a scoped day", a.changedDays.some((n) => scope.includes(n)), `changed ${a.changedDays.join(",")}`));
  if (a.id === "golf") {
    for (const n of scope) {
      const d = next.days[n - 1];
      r.push(check(`day ${n} still has golf`, !!d && golfRefs(next, d).length > 0));
    }
  }
  return r;
}

/** All `ref` values of the raw model days. */
export const rawRefs = (days: LlmPlan["days"]) =>
  days.flatMap((d) => d.stops.flatMap((s) => s.acts.flatMap((a) => (a.ref ? [a.ref] : []))));
