/** Shared by the CI checks (recorded) and the live runner: assemble/patch + all checks for one fixture. */
import { MODEL_PLAN } from "@/lib/domain/ai";
import type { LlmPatch, LlmPlan, Plan, PurposeTags } from "@/lib/domain/plan";
import { planInputHash } from "@/lib/plan/hash";
import { assemblePlan, type AssembleIssues } from "@/lib/plan/assemble";
import { applyPatch } from "@/lib/plan/patch";
import { buildEvalInput, FIXTURES, PATCH_FEEDBACK, type FixtureId } from "./build-input";
import { genericChecks, patchChecks, planChecks, rawRefs, tagChecks, type CheckResult } from "./checks";

export const RECORDED_GENERATED_AT = "2026-10-28T00:00:00.000Z";

export function evaluateTags(id: FixtureId, tags: PurposeTags): CheckResult[] {
  return tagChecks(id, tags);
}

/** `recordedHash`: input hash of the recording; a stale one skips checks that need the model to have seen the current input. */
export type EvalOpts = { recordedHash?: string };

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
  const fresh = opts.recordedHash === undefined || opts.recordedHash === planInputHash(built.stored.llm);
  if (!res.ok) {
    return { built, plan: null as Plan | null, issues: null as AssembleIssues | null, results: [{ name: "assemble", ok: false, detail: res.reason }] as CheckResult[] };
  }
  const startDate = built.trip.timing.kind === "date" ? built.trip.timing.startDate : undefined;
  const results = [
    { name: "assemble", ok: true },
    ...genericChecks({ plan: res.plan, stored: built.stored, rawRefs: rawRefs(llm.days), issues: res.issues, startDate, flightsRecorded: !!built.facts.flights }),
    ...planChecks(id, FIXTURES[id], res.plan, fresh),
  ];
  return { built, plan: res.plan as Plan | null, issues: res.issues as AssembleIssues | null, results };
}

export function evaluatePatch(id: FixtureId, tags: PurposeTags | null, base: Plan, patch: LlmPatch, opts: EvalOpts = {}) {
  const built = buildEvalInput(id, tags);
  const scope = PATCH_FEEDBACK[id].days;
  const res = applyPatch({ base, patch, stored: built.stored, scope });
  if (!res.ok) return { plan: null, results: [{ name: "applyPatch", ok: false, detail: res.reason }] as CheckResult[] };
  const startDate = built.trip.timing.kind === "date" ? built.trip.timing.startDate : undefined;
  const results: CheckResult[] = [
    { name: "applyPatch", ok: true },
    ...patchChecks({ id, base, next: res.plan, changedDays: res.changedDays, scope }),
    ...genericChecks({ plan: res.plan, stored: built.stored, rawRefs: rawRefs(patch.days), issues: res.issues, startDate }),
  ];
  if (id === "golf") {
    const fresh = opts.recordedHash === undefined || opts.recordedHash === planInputHash(built.stored.llm);
    results.push(...planChecks(id, FIXTURES[id], res.plan, fresh));
  }
  return { plan: res.plan, changedDays: res.changedDays, results };
}

export const formatResults = (title: string, rs: CheckResult[]) =>
  [title, ...rs.map((r) => `  ${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : ` (${r.detail})`}`)].join("\n");
