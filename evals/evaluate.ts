/** Shared by the CI checks (recorded) and the live runner: assemble/patch + all checks for one fixture. */
import { MODEL_PLAN } from "@/lib/domain/ai";
import type { LlmPatch, LlmPlan, Plan, PurposeTags } from "@/lib/domain/plan";
import { planInputHash } from "@/lib/plan/hash";
import { assemblePlan, type AssembleIssues } from "@/lib/plan/assemble";
import { applyPatch } from "@/lib/plan/patch";
import type { PlanInputStored } from "@/lib/plan/input";
import { extendInput, resolveNeedPlaces } from "@/lib/plan/need-places";
import {
  buildEvalInput, evalActivityLookups, evalInterestGroups, FAMILY_PATCH_FEEDBACK, FIXTURES, GOLF_EVERY_DAY_FEEDBACK, GOLF_PATCH_FEEDBACK, NO_GOLF_TAGS, noGolfPurpose, PATCH_FEEDBACK, UNCOVERED_PATCH_FEEDBACK, type FixtureId,
} from "./build-input";
import { guardPatch } from "@/lib/plan/patch-guard";
import { uncoveredPatchChecks, familyPatchChecks, genericChecks, golfEveryDayChecks, golfNeedPatchChecks,needPatchChecks, patchChecks, planChecks, rawRefs, tagChecks, type CheckResult } from "./checks";

export const RECORDED_GENERATED_AT = "2026-10-28T00:00:00.000Z";

/** Same input without fixed slots: assembling with it skips the overlap guard. */
const unguarded = (s: PlanInputStored): PlanInputStored => ({ ...s, llm: { ...s.llm, fixed: undefined } });

export function evaluateTags(id: FixtureId, tags: PurposeTags): CheckResult[] {
  return tagChecks(id, tags);
}

/** `recordedHash`: input hash of the recording; a stale one skips checks that need the model to have seen the current input. */
export type EvalOpts = { recordedHash?: string; recordedVersion?: string };

export function evaluateGenerate(id: FixtureId, tags: PurposeTags | null, llm: LlmPlan, opts: EvalOpts = {}) {
  const built = buildEvalInput(id, tags);
  const res = assemblePlan({
    llm,
    stored: built.stored,
    header: { ...built.header, generatedAt: RECORDED_GENERATED_AT, model: MODEL_PLAN },
    digest: built.digest,
    locale: FIXTURES[id].locale,
    flights: built.flights,
  });
  const fresh = opts.recordedHash === undefined || opts.recordedHash === planInputHash(built.stored.llm, opts.recordedVersion);
  // The model's own timing, before the code guard drops overlaps (fixed-item checks measure the model).
  const raw = assemblePlan({
    llm,
    stored: unguarded(built.stored),
    header: { ...built.header, generatedAt: RECORDED_GENERATED_AT, model: MODEL_PLAN },
    digest: built.digest,
    locale: FIXTURES[id].locale,
    flights: built.flights,
  });
  if (!res.ok) {
    return { built, plan: null as Plan | null, issues: null as AssembleIssues | null, results: [{ name: "assemble", ok: false, detail: res.reason }] as CheckResult[] };
  }
  const startDate = built.trip.timing.kind === "date" ? built.trip.timing.startDate : undefined;
  const results = [
    { name: "assemble", ok: true },
    ...genericChecks({ plan: res.plan, stored: built.stored, rawRefs: rawRefs(llm.days), issues: res.issues, startDate, flightsRecorded: !!built.facts.flights }),
    ...planChecks(id, FIXTURES[id], res.plan, fresh, built.stored, res.issues, raw.ok ? raw.plan : undefined),
  ];
  return { built, plan: res.plan as Plan | null, issues: res.issues as AssembleIssues | null, results };
}

export function evaluatePatch(id: FixtureId, tags: PurposeTags | null, base: Plan, patch: LlmPatch, opts: EvalOpts = {}) {
  const built = buildEvalInput(id, tags);
  const scope = PATCH_FEEDBACK[id].days;
  const res = applyPatch({ base, patch, stored: built.stored, scope });
  const raw = applyPatch({ base, patch, stored: built.stored, scope, fixed: undefined });
  if (!res.ok) return { plan: null, results: [{ name: "applyPatch", ok: false, detail: res.reason }] as CheckResult[] };
  const startDate = built.trip.timing.kind === "date" ? built.trip.timing.startDate : undefined;
  const results: CheckResult[] = [
    { name: "applyPatch", ok: true },
    ...patchChecks({ id, base, next: res.plan, changedDays: res.changedDays, scope }),
    ...genericChecks({ plan: res.plan, stored: built.stored, rawRefs: rawRefs(patch.days), issues: res.issues, startDate }),
  ];
  if (id === "golf") {
    const fresh = opts.recordedHash === undefined || opts.recordedHash === planInputHash(built.stored.llm, opts.recordedVersion);
    results.push(...planChecks(id, FIXTURES[id], res.plan, fresh, built.stored, res.issues, raw.ok ? raw.plan : undefined));
  }
  return { plan: res.plan, changedDays: res.changedDays, results };
}

/** Tags as stored before tags-2 learned activity wishes: the base of the needPlaces patch eval. */
export function withoutActivities(tags: PurposeTags | null): PurposeTags | null {
  if (!tags) return null;
  const copy = { ...tags };
  delete copy.activities;
  return copy;
}

/** Plan generated from an input without activity places (`needbase` recording). */
export function assembleNeedBase(id: FixtureId, tags: PurposeTags | null, llm: LlmPlan) {
  const built = buildEvalInput(id, withoutActivities(tags));
  const res = assemblePlan({
    llm,
    stored: built.stored,
    header: { ...built.header, generatedAt: RECORDED_GENERATED_AT, model: MODEL_PLAN },
    digest: built.digest,
    locale: FIXTURES[id].locale,
    flights: built.flights,
  });
  return { built, plan: res.ok ? res.plan : null, reason: res.ok ? undefined : res.reason };
}

/** The input of the second patch call: base input + the places the first call asked for (recorded lookups). */
export function needPatchInput(id: FixtureId, stored: PlanInputStored, first: LlmPatch): PlanInputStored | null {
  const req = resolveNeedPlaces(first.needPlaces, stored);
  if (!req) return null;
  const loaded = evalActivityLookups(id, req.groups);
  const interests = evalInterestGroups(id, req.interests ?? []);
  return extendInput(stored, req, { activities: loaded.activities, restaurants: req.restaurants ? loaded.restaurants : undefined, interests }, {
    lang: FIXTURES[id].locale,
    countryCode: FIXTURES[id].trip.anchor.countryCode,
  });
}

export type NeedPatchRecording = { first: LlmPatch; second: LlmPatch | null; firstUsage?: unknown };

/** Activities spec patch eval: needPlaces on the first call, then the second call's patch applied and checked. */
export function evaluateNeedPatch(id: FixtureId, tags: PurposeTags | null, baseLlm: LlmPlan, rec: NeedPatchRecording) {
  const base = assembleNeedBase(id, tags, baseLlm);
  if (!base.plan) return { plan: null, results: [{ name: "assemble base", ok: false, detail: base.reason }] as CheckResult[] };
  const extended = needPatchInput(id, base.built.stored, rec.first);
  if (!extended || !rec.second) {
    return { plan: null, results: [{ name: "needPlaces requested and second call made", ok: false, detail: JSON.stringify(rec.first.needPlaces ?? null) }] as CheckResult[] };
  }
  const scope = PATCH_FEEDBACK[id].days;
  const res = applyPatch({ base: base.plan, patch: rec.second, stored: extended, scope });
  if (!res.ok) return { plan: null, results: [{ name: "applyPatch", ok: false, detail: res.reason }] as CheckResult[] };
  const results: CheckResult[] = [
    { name: "applyPatch", ok: true },
    ...patchChecks({ id, base: base.plan, next: res.plan, changedDays: res.changedDays, scope }),
    ...genericChecks({ plan: res.plan, stored: extended, rawRefs: rawRefs(rec.second.days), issues: res.issues }),
    ...needPatchChecks({ first: rec.first, next: res.plan, stored: extended }),
  ];
  return { plan: res.plan, extended, results };
}

/**
 * Addendum 1 patch eval on the cruise generation: the first call (needPlaces for indoor_play, or a direct answer),
 * then the second call on the input extended with the recorded Passau indoor lookup.
 */
export function evaluateFamilyPatch(tags: PurposeTags | null, baseLlm: LlmPlan, rec: NeedPatchRecording) {
  const g = evaluateGenerate("cruise", tags, baseLlm);
  if (!g.plan) return { plan: null, results: [{ name: "assemble base", ok: false, detail: "cruise generation does not assemble" }] as CheckResult[] };
  const extended = needPatchInput("cruise", g.built.stored, rec.first);
  const stored = extended ?? g.built.stored;
  const patch = extended ? rec.second : rec.first;
  if (!patch) return { plan: null, results: [{ name: "second call made", ok: false, detail: JSON.stringify(rec.first.needPlaces ?? null) }] as CheckResult[] };
  const scope = FAMILY_PATCH_FEEDBACK.days;
  const res = applyPatch({ base: g.plan, patch, stored, scope });
  if (!res.ok) return { plan: null, results: [{ name: "applyPatch", ok: false, detail: res.reason }] as CheckResult[] };
  const results: CheckResult[] = [
    { name: "applyPatch", ok: true },
    ...patchChecks({ id: "cruise", base: g.plan, next: res.plan, changedDays: res.changedDays, scope }),
    ...genericChecks({ plan: res.plan, stored, rawRefs: rawRefs(patch.days), issues: res.issues }),
    ...familyPatchChecks({ first: rec.first, next: res.plan, stored }),
  ];
  return { plan: res.plan, extended, stored, base: g.built.stored, results };
}

/** Addendum A3 patch eval on the cruise generation: one call, no places to load. */
export function evaluateUncoveredPatch(tags: PurposeTags | null, baseLlm: LlmPlan, patch: LlmPatch) {
  const g = evaluateGenerate("cruise", tags, baseLlm);
  if (!g.plan) return { plan: null, results: [{ name: "assemble base", ok: false, detail: "cruise generation does not assemble" }] as CheckResult[] };
  const scope = UNCOVERED_PATCH_FEEDBACK.days;
  const res = applyPatch({ base: g.plan, patch, stored: g.built.stored, scope });
  if (!res.ok) return { plan: null, results: [{ name: "applyPatch", ok: false, detail: res.reason }] as CheckResult[] };
  const results: CheckResult[] = [
    { name: "applyPatch", ok: true },
    ...patchChecks({ id: "cruise", base: g.plan, next: res.plan, changedDays: res.changedDays, scope }),
    ...genericChecks({ plan: res.plan, stored: g.built.stored, rawRefs: rawRefs(patch.days), issues: res.issues }),
    ...uncoveredPatchChecks({ first: patch, next: res.plan, changedDays: res.changedDays }),
  ];
  return { plan: res.plan, results };
}

/** Issue #151 base: the golf fixture's trip planned for a purpose without golf (`nogolfbase` recording). */
export function buildNoGolfInput() {
  return buildEvalInput("golf", NO_GOLF_TAGS, noGolfPurpose());
}

export function assembleNoGolfBase(llm: LlmPlan) {
  const built = buildNoGolfInput();
  const res = assemblePlan({
    llm,
    stored: built.stored,
    header: { ...built.header, generatedAt: RECORDED_GENERATED_AT, model: MODEL_PLAN },
    digest: built.digest,
    locale: FIXTURES.golf.locale,
    flights: built.flights,
  });
  return { built, plan: res.ok ? res.plan : null, reason: res.ok ? undefined : res.reason };
}

/** Issue #151 patch eval: "find a golf course for day 2" loads the golf interest and patches day 2 with a ref. */
export function evaluateGolfPatch(baseLlm: LlmPlan, rec: NeedPatchRecording) {
  const base = assembleNoGolfBase(baseLlm);
  if (!base.plan) return { plan: null, results: [{ name: "assemble base", ok: false, detail: base.reason }] as CheckResult[] };
  const extended = needPatchInput("golf", base.built.stored, rec.first);
  if (!extended || !rec.second) {
    return { plan: null, results: [{ name: "needPlaces requested and second call made", ok: false, detail: JSON.stringify(rec.first.needPlaces ?? null) }] as CheckResult[] };
  }
  const scope = GOLF_PATCH_FEEDBACK.days;
  const res = applyPatch({ base: base.plan, patch: rec.second, stored: extended, scope });
  if (!res.ok) return { plan: null, results: [{ name: "applyPatch", ok: false, detail: res.reason }] as CheckResult[] };
  const results: CheckResult[] = [
    { name: "applyPatch", ok: true },
    ...patchChecks({ id: "golf", base: base.plan, next: res.plan, changedDays: res.changedDays, scope }),
    ...genericChecks({ plan: res.plan, stored: extended, rawRefs: rawRefs(rec.second.days), issues: res.issues }),
    ...golfNeedPatchChecks({ first: rec.first, next: res.plan, stored: extended }),
  ];
  return { plan: res.plan, extended, results };
}

/**
 * Issue #158 patch eval: "golf on every day" without day scope on the no-golf base. Runs the production path after
 * the second call: applyPatch (all days in scope) and the shrink guard, then checks every day.
 */
export function evaluateGolfEveryDay(baseLlm: LlmPlan, rec: NeedPatchRecording) {
  const base = assembleNoGolfBase(baseLlm);
  if (!base.plan) return { plan: null, results: [{ name: "assemble base", ok: false, detail: base.reason }] as CheckResult[] };
  const extended = needPatchInput("golf", base.built.stored, rec.first);
  if (!extended || !rec.second) {
    return { plan: null, results: [{ name: "needPlaces requested and second call made", ok: false, detail: JSON.stringify(rec.first.needPlaces ?? null) }] as CheckResult[] };
  }
  const feedback = GOLF_EVERY_DAY_FEEDBACK;
  const res = applyPatch({ base: base.plan, patch: rec.second, stored: extended, scope: feedback.days });
  if (!res.ok) return { plan: null, results: [{ name: "applyPatch", ok: false, detail: res.reason }] as CheckResult[] };
  const guarded = guardPatch({ base: base.plan, next: res.plan, feedback, index: extended.index });
  const all = base.plan.days.map((d) => d.n);
  const results: CheckResult[] = [
    { name: "applyPatch", ok: true },
    ...patchChecks({ id: "golf", base: base.plan, next: guarded.plan, changedDays: guarded.changedDays, scope: all }),
    ...genericChecks({ plan: guarded.plan, stored: extended, rawRefs: rawRefs(rec.second.days), issues: res.issues }),
    ...golfEveryDayChecks({ first: rec.first, second: rec.second, next: guarded.plan, rejected: guarded.rejected.map((r) => r.n) }),
  ];
  return { plan: guarded.plan, extended, patched: res, guarded, results };
}

export const formatResults =(title: string, rs: CheckResult[]) =>
  [title, ...rs.map((r) => `  ${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : ` (${r.detail})`}`)].join("\n");
