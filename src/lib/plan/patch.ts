import type { LlmPatch, Plan } from "@/lib/domain/plan";
import type { AssembleIssues } from "./assemble";
import type { PlanInputStored } from "./input";
import { notImplemented } from "./not-implemented";

/** Applies a day patch; unaffected days keep their base objects (spec 4.5). */
export function applyPatch(a: {
  base: Plan;
  patch: LlmPatch;
  stored: PlanInputStored;
  scope: number[];
}):
  | { ok: true; plan: Plan; changedDays: number[]; issues: AssembleIssues }
  | { ok: false; reason: "day_count" | "schema" | "out_of_scope_only" } {
  void a;
  return notImplemented("applyPatch");
}
