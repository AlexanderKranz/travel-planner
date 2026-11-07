/** Deterministic eval checks (spec 7). Pure: no network, no model. */
import type { LlmPatch, LlmPlan, Plan, PlanDay, PurposeTags } from "@/lib/domain/plan";
import type { AssembleIssues } from "@/lib/plan/assemble";
import { addDays } from "@/lib/facts/trip-timing";
import { canonicalJson } from "@/lib/plan/hash";
import { overlapsSlot } from "@/lib/plan/fixed-items";
import type { PlanInputStored } from "@/lib/plan/input";
import { scheduleNotes, type EvalFixture, type FixtureId, type ScheduleEntry } from "./build-input";
import { ACTIVITY_SOURCES, isOpenAirBath, type ActivityType } from "@/lib/facts/activity-types";
import { FAST_FOOD_CUISINES, LOCAL_CUISINE } from "@/lib/facts/cuisine";
import { noteTimes } from "@/lib/plan/assemble";
import { DISTANCE_TEXT } from "@/lib/plan/distance-text";
import { isOpenAirPlace, placeClasses } from "@/lib/plan/open-air";
import { ARRIVAL_DEPARTURE } from "@/lib/plan/schedule-times";

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

/** Checks for every fixture: structure, refs, invented facts, no model best day. */
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
    // Issue #142: the app shows verified distances and drive times; prose never states one.
    ["no distances in prose", DISTANCE_TEXT],
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
  // The best day is set by the user only (patch-safety [D8]); the model output never carries one.
  r.push(check("no best day from the model", plan.days.every((d) => !d.best)));
  r.push(...kidsClaimChecks(plan, stored));
  return r;
}

/** Child-friendliness wording (de + en) that only a kids-tagged restaurant or café may carry (addendum A4). */
export const KIDS_CLAIM = /kinderfreundlich|kindgerecht|familienfreundlich|child[- ]friendly|kid[- ]friendly|family[- ]friendly|hochstuhl|high ?chair|wickeltisch|changing table|spielecke|kinderecke|kids? (area|corner)/i;

/** Addendum A4: no restaurant or café is called child-friendly unless its input entry carries `k`. */
export function kidsClaimChecks(plan: Plan, stored: PlanInputStored): CheckResult[] {
  const tagged = new Set<string>();
  const eating = new Set<string>();
  for (const block of [stored.llm.restaurants, stored.llm.restaurantsNear, stored.llm.cafes]) {
    for (const e of block?.list ?? []) {
      const key = stored.index[e.id]?.key as string | undefined;
      if (!key) continue;
      eating.add(key);
      if (e.k) tagged.add(key);
    }
  }
  const bad = allActs(plan).filter(({ a }) => a.ref && eating.has(a.ref) && !tagged.has(a.ref) && KIDS_CLAIM.test(a.text));
  return [check("no restaurant or café called child-friendly without a kids tag", bad.length === 0, bad.map(({ d, a }) => `d${d} ${a.text}`).join(" | "))];
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
    ...openAirChecks(plan, stored),
  ];
}

/**
 * Issue #142: no open-air pool (by its OSM classification: name, note, indoor/covered tags) as ref or alternative
 * in winter (every fixture day with open-air checks is in December) or for an indoor activity.
 */
export function openAirChecks(plan: Plan, stored: PlanInputStored, days?: number[]): CheckResult[] {
  const c = placeClasses(stored);
  const bad = allActs(plan)
    .filter(({ d }) => !days || days.includes(d))
    .flatMap(({ d, a }) => [a.ref, ...(a.ref ? (a.alts ?? []) : [])].filter((k): k is string => !!k && isOpenAirPlace(k, c)).map((k) => `d${d} ${a.text} [${c.name.get(k)}]`));
  return [check("no open-air pool as ref or alternative in December", bad.length === 0, bad.slice(0, 4).join(" | "))];
}

/**
 * Issue #142 (prompt rule 5, D9): a schedule entry without a clock time ("Passau an morgens") never gets one. At a
 * stop of that place on that day: no window time and no arrival/departure activity time that is not in the notes.
 */
export function scheduleTimeChecks(plan: Plan, schedule: ScheduleEntry[], notes: string | undefined): CheckResult[] {
  const times = noteTimes(notes);
  const r: CheckResult[] = [];
  for (const e of schedule.filter((x) => (x.arrive && !isHhmm(x.arrive)) || (x.depart && !isHhmm(x.depart)))) {
    const day = plan.days.find((d) => d.date === e.date);
    const stops = day?.stops.filter((s) => placeMatches(s.place, e.place)) ?? [];
    const bad = stops.flatMap((s) => [
      ...[s.from, s.to].filter((t) => t && !times.has(t)).map((t) => `${s.place} window ${t}`),
      ...s.acts.filter((a) => ARRIVAL_DEPARTURE.test(a.text) && [a.at, a.until].some((t) => t && !times.has(t))).map((a) => `${a.at} ${a.text}`),
    ]);
    r.push(check(`no invented time: ${e.date} ${e.place} ${e.arrive ?? ""}${e.depart ?? ""}`, bad.length === 0, bad.join(" | ")));
  }
  return r;
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

export function cruiseChecks(plan: Plan, c: EvalFixture["checks"], schedule: ScheduleEntry[], notes?: string): CheckResult[] {
  const r: CheckResult[] = [...scheduleTimeChecks(plan, schedule, notes)];
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
  if (id === "wuerzburg") {
    const wishes = tags.activities ?? [];
    const water = ["rowing", "footgolf", "boat_rental", "canoe"];
    return [
      check("tags: v2", tags.v === 2),
      check("tags: open escape room wish", wishes.some((w) => w.types.includes("escape_game") && w.open), JSON.stringify(wishes)),
      check("tags: water/footgolf wish", wishes.some((w) => w.types.some((t) => water.includes(t))), JSON.stringify(wishes)),
      check("tags: local cuisine", tags.cuisine?.local === true, JSON.stringify(tags.cuisine ?? null)),
    ];
  }
  if (id === "golf") {
    return [
      check("tags: interests contain golf", tags.interests.includes("golf"), tags.interests.join(",")),
      check("tags: >= 3 hard constraints", tags.hard.length >= 3, String(tags.hard.length)),
    ];
  }
  return [
    check("tags: interests contain christmas_markets", tags.interests.includes("christmas_markets"), tags.interests.join(",")),
    // Issue #142: "mit Kleinkind" always brings family places (code fallback after Haiku).
    check("tags: interests contain family_activities", tags.interests.includes("family_activities"), tags.interests.join(",")),
  ];
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
  if (id === "wuerzburg") return stored && fresh && fixture.checks.activities ? activityChecks(plan, stored) : [];
  const r = cruiseChecks(plan, fixture.checks, fixture.fixedSchedule ?? [], stored?.llm.trip.notes ?? scheduleNotes(fixture.fixedSchedule ?? []));
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

const EVENING = "17:00";

/** OSM key -> activity type / effective group, and restaurant key -> cuisines, from the stored input. */
function inputMaps(stored: PlanInputStored) {
  const keyOf = (id: string) => stored.index[id]?.key as string | undefined;
  const acts = new Map<string, { t: ActivityType[]; g: string }>();
  for (const p of stored.llm.activities?.places ?? []) {
    const k = keyOf(p.id);
    if (k) acts.set(k, { t: p.t, g: p.g });
  }
  const rest = new Map<string, string[]>();
  for (const block of [stored.llm.restaurants, stored.llm.restaurantsNear]) {
    for (const r of block?.list ?? []) {
      const k = keyOf(r.id);
      if (k) rest.set(k, r.c ? r.c.split(";") : []);
    }
  }
  return { acts, rest };
}

/**
 * Activities spec (Evals): Friday evening = an indoor venue with an alternative of another type; Saturday = an
 * outdoor type; every dinner on days 1-2 names a restaurant with local cuisine (when asked); no fast-food ref
 * without a wish for it; a footgolf wish without places is stated, not invented.
 */
export function activityChecks(plan: Plan, stored: PlanInputStored): CheckResult[] {
  const { acts, rest } = inputMaps(stored);
  const r: CheckResult[] = [];
  r.push(check("activity places reach the model", acts.size > 0, "none in input"));
  r.push(check("restaurants reach the model", rest.size > 0, "none in input"));
  const actsOf = (n: number) => plan.days[n - 1]?.stops.flatMap((s) => s.acts) ?? [];
  const evening = actsOf(1).find((a) => a.ref && acts.has(a.ref) && (!a.at || a.at >= EVENING));
  const ev = evening?.ref ? acts.get(evening.ref) : undefined;
  r.push(check("day 1 evening: indoor venue ref", ev?.g === "indoor", evening ? `${evening.at} ${evening.text} -> ${ev?.t}/${ev?.g}` : "no evening activity with an activity ref"));
  const altTypes = (evening?.alts ?? []).map((k) => acts.get(k)?.t ?? []);
  // Another kind: an alternative with a type the venue itself does not have.
  r.push(check("day 1 evening: an alternative of another type", altTypes.some((ts) => ts.some((t) => !ev?.t.includes(t))), `ref ${ev?.t}, alts ${altTypes.map((ts) => ts.join("+")).join(",")}`));
  const sat = actsOf(2).filter((a) => a.ref && acts.has(a.ref)).map((a) => acts.get(a.ref!)!);
  r.push(check("day 2: an outdoor type", sat.some((x) => x.t.some((t) => ACTIVITY_SOURCES[t].group === "outdoor")), sat.map((x) => x.t.join("+")).join(",") || "no activity ref"));
  const ask = stored.llm.restaurants?.ask;
  const local = new Set(LOCAL_CUISINE.DE);
  for (const n of [1, 2]) {
    const dinners = actsOf(n).filter((a) => a.kind === "food" && a.at && a.at >= EVENING);
    const ok = dinners.length > 0 && dinners.every((a) => a.ref && rest.has(a.ref) && (!ask?.local || rest.get(a.ref)!.some((c) => local.has(c))));
    r.push(check(`day ${n} dinner: restaurant ref${ask?.local ? " with local cuisine" : ""}`, ok, dinners.map((a) => `${a.at} ${a.text} ${a.ref ? rest.get(a.ref)?.join(";") ?? "not a restaurant" : "no ref"}`).join(" | ") || "no dinner"));
  }
  const include = new Set(ask?.include ?? []);
  const fast = plan.days.flatMap((d) => d.stops.flatMap((s) => s.acts)).filter((a) => a.ref && rest.get(a.ref)?.some((c) => FAST_FOOD_CUISINES.has(c) && !include.has(c)));
  r.push(check("no pizza/burger restaurant without a wish for it", fast.length === 0, fast.map((a) => a.text).join(" | ")));
  const footgolfEmpty = stored.llm.activities?.wishes.some((w) => w.types.some((t) => t.t === "footgolf" && t.s === "empty"));
  if (footgolfEmpty) {
    const stated = proseOf(plan).some((t) => /footgolf/i.test(t) && /openstreetmap|nicht gefunden|keine?n?\b|not found|no footgolf/i.test(t));
    r.push(check("missing footgolf is stated", stated, proseOf(plan).filter((t) => /footgolf/i.test(t)).join(" | ") || "footgolf not mentioned"));
  }
  return r;
}

/** Indoor family venues for the addendum-1 patch eval: indoor playgrounds and pools by OSM tag. */
const FAMILY_INDOOR_CATS = new Set(["leisure=indoor_play", "leisure=water_park", "amenity=public_bath", "leisure=sports_centre"]);
const FAMILY_INDOOR_TEXT = /indoor|spielplatz|spielhalle|hallenbad|schwimmbad|erlebnisbad|spaßbad|therme|playground|soft play|swimming|pool/i;
/** A3 / D6 wording: not covered by the verified sources, or nothing found nearby in OpenStreetMap. */
export const HONEST_WORDING = /geprüften quellen|openstreetmap|nicht gefunden|keine?n? .*(gefunden|gelistet|verzeichnet)|not covered|not found|no .* listed/i;
const FALSE_WORDING = /keine geprüften orte|no verified places/i;

/**
 * Addendum 1 patch eval (cruise, toddler): "concrete indoor playground examples on day 1". Day 1 ends with a ref to
 * an indoor_play or (covered) swimming place, or says honestly that none is listed / covered; no open-air pool in
 * December; never "keine geprüften Orte gefunden"; every day-1 activity about such a venue either has a ref or the
 * day states the honest wording (no generic venue presented as a suggestion).
 */
export function familyPatchChecks(a: { first: LlmPatch; next: Plan; stored: PlanInputStored }): CheckResult[] {
  const day = a.next.days[0];
  const acts = day?.stops.flatMap((s) => s.acts) ?? [];
  const byKey = new Map(Object.values(a.stored.index).map((e) => [e.key as string, e.place]));
  const venue = (ref: string | undefined) => (ref ? byKey.get(ref) : undefined);
  const indoorRefs = acts.filter((x) => {
    const p = venue(x.ref);
    return !!p && FAMILY_INDOOR_CATS.has(p.category) && !isOpenAirBath({ name: p.name });
  });
  // Issue #142: alternatives count too, and the classification is the input's (OSM note "Freibad" included).
  const classes = placeClasses(a.stored);
  const openAir = acts.filter((x) => !!x.ref && [x.ref, ...(x.alts ?? [])].some((k) => isOpenAirPlace(k, classes)));
  const dayProse = day ? [day.title, day.note ?? "", day.warn ?? "", ...acts.map((x) => x.text)] : [];
  const honest = dayProse.some((t) => HONEST_WORDING.test(t)) || a.next.notes.some((n) => HONEST_WORDING.test(n.text));
  const generic = acts.filter((x) => !x.ref && FAMILY_INDOOR_TEXT.test(x.text));
  const show = (xs: typeof acts) => xs.map((x) => `${x.text}${x.ref ? ` [${venue(x.ref)?.name}]` : ""}`).join(" | ");
  return [
    check("first call requests indoor_play places (needPlaces)", (a.first.needPlaces?.types ?? []).includes("indoor_play"), JSON.stringify(a.first.needPlaces ?? null)),
    check("day 1: indoor play/pool ref or honest wording", indoorRefs.length > 0 || honest, show(acts)),
    check("day 1: no open-air pool as ref or alternative in December", openAir.length === 0, show(openAir)),
    check("never 'keine geprüften Orte gefunden'", !proseOf(a.next).some((t) => FALSE_WORDING.test(t)), proseOf(a.next).filter((t) => FALSE_WORDING.test(t)).join(" | ")),
    check("generic indoor venue only with the honest wording", generic.length === 0 || honest, show(generic)),
  ];
}

/**
 * Addendum A3 patch eval (cruise): "concrete examples for a children's farm on day 1". No catalogue type covers it:
 * no loadable needPlaces, the day keeps it as an idea and says the verified sources do not cover it, never "keine
 * geprüften Orte gefunden" and never "nothing found in OpenStreetMap" (that is reserved for an empty lookup).
 */
export function uncoveredPatchChecks(a: { first: LlmPatch; next: Plan; changedDays: number[] }): CheckResult[] {
  const days = a.next.days.filter((d) => a.changedDays.includes(d.n));
  const prose = [...days.flatMap((d) => [d.title, d.note ?? "", d.warn ?? "", ...d.stops.flatMap((s) => s.acts.map((x) => x.text))]), ...a.next.notes.map((n) => n.text)];
  const covered = /geprüften quellen|verified sources/i;
  return [
    check("no loadable needPlaces for an uncovered kind", !a.first.needPlaces, JSON.stringify(a.first.needPlaces ?? null)),
    check("says the verified sources do not cover it", prose.some((t) => covered.test(t)), prose.filter((t) => /bauernhof|farm/i.test(t)).join(" | ")),
    check("never 'keine geprüften Orte gefunden'", !proseOf(a.next).some((t) => FALSE_WORDING.test(t))),
    check("no OpenStreetMap 'nothing found' claim", !prose.some((t) => /openstreetmap/i.test(t)), prose.filter((t) => /openstreetmap/i.test(t)).join(" | ")),
  ];
}

/** Patch eval: the change request asked for escape rooms on a plan without them; day 1 ends with an escape room ref. */
export function needPatchChecks(a: { first: LlmPatch; next: Plan; stored: PlanInputStored }): CheckResult[] {
  const types = a.first.needPlaces?.types ?? [];
  const day1 = a.next.days[0]?.stops.flatMap((s) => s.acts) ?? [];
  const escapeKeys = new Set<string>(
    Object.values(a.stored.index ?? {}).flatMap((e) => (e.place.category === "leisure=escape_game" ? [e.key] : [])),
  );
  const hit = day1.find((x) => x.ref && escapeKeys.has(x.ref));
  return [
    check("first call requests escape_game places (needPlaces)", types.includes("escape_game"), JSON.stringify(a.first.needPlaces ?? null)),
    check("day 1 has an escape room ref after loading", !!hit, day1.map((x) => `${x.text}${x.ref ? ` [${x.ref}]` : ""}`).join(" | ")),
  ];
}

/**
 * Issue #158 (Costa del Sol, purpose without golf): "golf on every day", no day scope. The first call asks for the
 * golf interest; after loading and the shrink guard, every day has a round at a loaded course (golfPlaceChecks: no
 * sport activity without a golf course ref), no day was reverted, and the full days keep a meal.
 */
export function golfEveryDayChecks(a: { first: LlmPatch; second: LlmPatch; next: Plan; rejected: number[] }): CheckResult[] {
  const noGolf = a.next.days.filter((d) => golfRefs(a.next, d).length === 0).map((d) => d.n);
  const inner = a.next.days.slice(1, -1);
  const noMeal = inner.filter((d) => !d.stops.some((s) => s.acts.some((x) => x.kind === "food"))).map((d) => d.n);
  return [
    check("first call requests the golf interest (needPlaces)", (a.first.needPlaces?.interests ?? []).includes("golf"), JSON.stringify(a.first.needPlaces ?? null)),
    check("second call returns every day", a.second.days.length === a.next.days.length, `returned ${a.second.days.map((d) => d.n).join(",")}`),
    check("shrink guard reverts no day", a.rejected.length === 0, `reverted ${a.rejected.join(",")}`),
    check("every day has a golf round at a loaded course", noGolf.length === 0, `no golf on day ${noGolf.join(",")}`),
    ...golfPlaceChecks(a.next),
    check("full days keep a meal", noMeal.length === 0, `no meal on day ${noMeal.join(",")}`),
  ];
}

/**
 * Issue #151 patch eval (Costa del Sol, purpose without golf): "find a golf course for day 2". The first call asks for
 * the golf interest; after loading, day 2 has a golf course ref and nothing says golf is not covered by the sources.
 */
export function golfNeedPatchChecks(a: { first: LlmPatch; next: Plan; stored: PlanInputStored }): CheckResult[] {
  const day2 = a.next.days[1];
  const acts = day2?.stops.flatMap((s) => s.acts) ?? [];
  const golfKeys = new Set<string>(Object.values(a.stored.index).flatMap((e) => (e.place.category === "leisure=golf_course" ? [e.key] : [])));
  const hit = acts.find((x) => x.ref && golfKeys.has(x.ref));
  // Per sentence: the base purpose's beaches have no recording, so "beaches are not covered" is honest there.
  const notCovered = (t: string) => t.split(/(?<=[.!?])\s+/).some((s) => /golf/i.test(s) && /geprüften quellen|verified sources/i.test(s));
  const prose = day2 ? [day2.title, day2.note ?? "", day2.warn ?? "", ...acts.map((x) => x.text)] : [];
  return [
    check("first call requests the golf interest (needPlaces)", (a.first.needPlaces?.interests ?? []).includes("golf"), JSON.stringify(a.first.needPlaces ?? null)),
    check("day 2 has a golf course ref after loading", !!hit, acts.map((x) => `${x.text}${x.ref ? ` [${x.ref}]` : ""}`).join(" | ")),
    check("never says golf is not covered by the verified sources", !prose.some(notCovered), prose.filter(notCovered).join(" | ")),
    check("never 'keine geprüften Orte gefunden'", !proseOf(a.next).some((t) => FALSE_WORDING.test(t))),
  ];
}
