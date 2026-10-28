import "server-only";
import type { AiCtx, AiResult } from "@/lib/domain/ai";
import type { LlmPatch, LlmPlan, Plan, PlanFeedback } from "@/lib/domain/plan";
import type { PlanInput, PlanInputStored } from "@/lib/plan/input";
import { notImplemented } from "@/lib/plan/not-implemented";

export async function composePlan(llm: PlanInput, ctx: AiCtx): Promise<AiResult<LlmPlan>> {
  void llm;
  void ctx;
  return notImplemented("composePlan");
}

export async function patchPlan(
  a: { llm: PlanInput; plan: Plan; index: PlanInputStored["index"]; feedback: PlanFeedback },
  ctx: AiCtx,
): Promise<AiResult<LlmPatch>> {
  void a;
  void ctx;
  return notImplemented("patchPlan");
}
