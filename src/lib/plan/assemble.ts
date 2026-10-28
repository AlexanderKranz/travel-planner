import type { Locale } from "@/lib/domain/profile";
import type { LlmPlan, Plan, PlanFactsDigest, PlanHeader } from "@/lib/domain/plan";
import type { PlanInputStored } from "./input";
import { notImplemented } from "./not-implemented";

export type AssembleIssue = "invalid_ref" | "bad_time" | "truncated" | "extra_best" | "window_violation";
export type AssembleIssues = Record<AssembleIssue, number>;

/** Model output + code facts → stored `Plan` (spec 4.5). */
export function assemblePlan(a: {
  llm: LlmPlan;
  stored: PlanInputStored;
  header: PlanHeader;
  digest: PlanFactsDigest;
  locale: Locale;
}): { ok: true; plan: Plan; issues: AssembleIssues } | { ok: false; reason: "day_count" | "schema" } {
  void a;
  return notImplemented("assemblePlan");
}
