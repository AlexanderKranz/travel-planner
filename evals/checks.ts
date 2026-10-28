/** Deterministic eval checks (spec 7). Pure: no network, no model. */
import type { LlmPlan, Plan, PlanDay, PurposeTags } from "@/lib/domain/plan";
import type { AssembleIssues } from "@/lib/plan/assemble";
import { addDays } from "@/lib/facts/trip-timing";
import { canonicalJson } from "@/lib/plan/hash";
import { overlapsSlot } from "@/lib/plan/fixed-items";
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

/**
 * Flights: verified outbound leg, proxy label, and (only for a fresh recording) day 1 starts after arrival + 90 min.
 * A fixed (booked/planned) arrival flight replaces the schedule heuristic: then fixedItemChecks covers day 1.
 */
export function flightChecks(plan: Plan, fresh: boolean, stored?: PlanInputStored): CheckResult[] {
  const f = plan.flights;
  if (!f) return [check("plan.flights present", false)];
  const outs = f.legs.filter((l) => l.dir === "out" && l.from === "FRA" && l.to === "AGP" && !l.tooLong && l.blockMin <= 180);
  const r = [
    check("flights: out FRA-AGP leg <= 3 h, not tooLong", outs.length > 0, f.legs.map((l) => `${l.from}${l.to}${l.blockMin}`).join(",")),
    check("flights: mode proxy (2038 is beyond the horizon)", f.mode.out === "proxy" && f.mode.back === "proxy"),
  ];
  const fixedArrival = (stored?.llm.fixed ?? []).some((x) => x.cat === "flight" && x.day === 1);
  if (fresh && outs.length && !fixedArrival) {
    const earliest = Math.min(...outs.map((l) => toMin(l.arr)));
    const first = plan.days[0]?.stops.flatMap((s) => s.acts.map((a) => a.at)).filter(isHhmm).sort()[0];
    r.push(check("day 1 first activity >= earliest arrival + 90 min", !first || toMin(first) >= earliest + 90, `first ${first}, arrival ${Math.min(...outs.map((l) => toMin(l.arr)))}`));
  }
  return r;
}

/** OSM key → interest of the input place (from the stored input). */
export function refInterests(stored: PlanInputStored): Map<string, string> {
  const byId = new Map(stored.llm.places.map((p) => [p.id, p.i]));
  return new Map(Object.entries(stored.index).map(([id, v]) => [v.key, byId.get(id) ?? ""]));
}

const allActs = (plan: Plan) => plan.days.flatMap((d) => d.stops.flatMap((s) => s.acts.map((a) => ({ d: d.n, a }))));

/** Concrete places (plan-3): every sport activity names a golf course; alts are golf courses too. */
export function golfPlaceChecks(plan: Plan): CheckResult[] {
  const sport = allActs(plan).filter(({ a }) => a.kind === "sport");
  const generic = sport.filter(({ a }) => !a.ref || plan.places[a.ref]?.category !== GOLF_CAT);
  const badAlts = sport.filter(({ a }) => (a.alts ?? []).some((k) => plan.places[k]?.category !== GOLF_CAT));
  return [
    check("every sport activity has a ref to a golf course", sport.length > 0 && generic.length === 0, generic.map(({ d, a }) => `d${d} ${a.text}`).slice(0, 4).join(" | ")),
    check("sport alternatives are golf courses", badAlts.length === 0, badAlts.map(({ d }) => `d${d}`).join(",")),
  ];
}

/** Zoo/park/aquarium wording (de + en) that must point to a verified place when the input has family places. */
export const FAMILY_TEXT = /\b(zoo|tierpark|tiergarten|aquarium|freizeitpark|vergnügungspark|erlebnispark|wasserpark|erlebnisbad|spaßbad|theme park|amusement park|water park|wildpark)/i;

/**
 * Concrete places (plan-3): with family places in the input, every zoo/park-type activity names one (ref);
 * a generic "zoo or amusement park" without ref fails. Whether the model picks a family venue at all is a
 * content choice (an advent cruise may skip it), so usage is not required.
 */
export function familyPlaceChecks(plan: Plan, stored: PlanInputStored): CheckResult[] {
  const interests = refInterests(stored);
  const available = stored.llm.places.filter((p) => p.i === "family_activities").length;
  const acts = allActs(plan);
  const generic = acts.filter(({ a }) => FAMILY_TEXT.test(a.text) && !(a.ref && interests.get(a.ref) === "family_activities"));
  return [
    check("family places reach the model", available > 0, "none in input"),
    check("zoo/park activities name a verified family place (ref)", generic.length === 0, generic.map(({ d, a }) => `d${d} ${a.text}`).slice(0, 3).join(" | ")),
  ];
}

/** Timed activities of one day: [start, end] in minutes (end = until, else start). */
const timedActs = (d: PlanDay) =>
  d.stops.flatMap((s) => s.acts).flatMap((a) => (isHhmm(a.at) ? [{ a, from: toMin(a.at), to: isHhmm(a.until) ? toMin(a.until) : toMin(a.at) }] : []));

/**
 * Fixed items (plan-4, timed-items spec), on the model's raw plan (`raw`, before the code guard; falls back to
 * `plan`): day-1 activities start >= 90 min after a fixed arrival flight ends, the last day's activities end
 * >= 150 min before a fixed departure, no raw activity overlaps a fixed item. The stored plan (after the guard)
 * must never overlap one.
 */
export function fixedItemChecks(plan: Plan, stored: PlanInputStored, issues?: AssembleIssues | null, raw?: Plan): CheckResult[] {
  const fixed = stored.llm.fixed ?? [];
  const r: CheckResult[] = [check("fixed items reach the model", fixed.length > 0, "none in input")];
  const m = raw ?? plan;
  const N = m.days.length;
  for (const f of fixed.filter((x) => x.cat === "flight" && x.day === 1)) {
    const ready = toMin(f.to ?? f.from) + 90;
    const early = timedActs(m.days[0]).filter((x) => x.from < ready);
    r.push(check(`day 1 activities start >= arrival ${f.to ?? f.from} + 90 min`, early.length === 0, early.map((x) => `${x.a.at} ${x.a.text}`).join(" | ")));
  }
  for (const f of fixed.filter((x) => x.cat === "flight" && x.day === N && x.day !== 1)) {
    const latest = toMin(f.from) - 150;
    const late = timedActs(m.days[N - 1]).filter((x) => x.to > latest);
    r.push(check(`last day activities end <= departure ${f.from} - 150 min`, late.length === 0, late.map((x) => `${x.a.at} ${x.a.text}`).join(" | ")));
  }
  const overlapsIn = (p: Plan) =>
    p.days.flatMap((d) =>
      d.stops.flatMap((s) => s.acts).filter((a) => fixed.some((f) => f.day === d.n && overlapsSlot(a, f))).map((a) => `d${d.n} ${a.at} ${a.text}`),
    );
  const modelOverlaps = overlapsIn(m);
  r.push(check("model: no activity overlaps a fixed item", modelOverlaps.length === 0 && (!!raw || !issues || issues.fixed_overlap === 0), modelOverlaps.slice(0, 3).join(" | ") || `guard dropped ${issues?.fixed_overlap}`));
  const stored_ = overlapsIn(plan);
  r.push(check("stored plan: no activity overlaps a fixed item", stored_.length === 0, stored_.slice(0, 3).join(" | ")));
  return r;
}

export function golfChecks(
  plan: Plan,
  c: EvalFixture["checks"],
  fresh = true,
  stored?: PlanInputStored,
  issues?: AssembleIssues | null,
  raw?: Plan,
): CheckResult[] {
  const r: CheckResult[] = [...flightChecks(plan, fresh, stored), ...golfPlaceChecks(plan)];
  if (c.fixedItems && stored && fresh) r.push(...fixedItemChecks(plan, stored, issues, raw));
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

export function planChecks(
  id: FixtureId,
  fixture: EvalFixture,
  plan: Plan,
  fresh = true,
  stored?: PlanInputStored,
  issues?: AssembleIssues | null,
  raw?: Plan,
): CheckResult[] {
  if (id === "golf") return golfChecks(plan, fixture.checks, fresh, stored, issues, raw);
  const r = cruiseChecks(plan, fixture.checks, fixture.fixedSchedule ?? []);
  // Only for a recording made from the current input: an older one never saw the family places.
  if (stored && fresh) r.push(...familyPlaceChecks(plan, stored));
  return r;
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
