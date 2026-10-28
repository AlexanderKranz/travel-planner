import "server-only";
import { z } from "zod";
import { MODEL_PLAN, type AiCtx, type AiResult } from "@/lib/domain/ai";
import { ActivityKind, type LlmDay, type LlmPatch, type LlmPlan, type Plan, type PlanDay, type PlanFeedback } from "@/lib/domain/plan";
import { CHIP_INSTRUCTIONS } from "@/lib/plan/chips";
import { canonicalJson } from "@/lib/plan/hash";
import type { PlanInput, PlanInputStored } from "@/lib/plan/input";
import { PATCH_ADDENDUM, SYSTEM_RULES } from "@/lib/plan/prompt";
import { callStructured, type StructuredRequest } from "./client";

export const PATCH_MAX_TOKENS = 8000;
export const generateMaxTokens = (days: number) => Math.min(32000, 6000 + 1200 * days);

// Lenient wire schemas: enums are only description hints in structured outputs (SDK 1.3), so a stray
// `kind` must not fail the whole plan. Unknown kinds are mapped in code (activity → "do", note → "tip").
const KINDS = ActivityKind.options.join("|");
const WireAct = z.object({
  at: z.string().optional(),
  until: z.string().optional(),
  kind: z.string().describe(KINDS),
  text: z.string(),
  ref: z.string().optional(),
});
const WireStop = z.object({
  place: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  fixed: z.boolean().optional(),
  acts: z.array(WireAct),
});
const WireDay = z.object({
  n: z.number().int(),
  title: z.string(),
  stops: z.array(WireStop),
  note: z.string().optional(),
  warn: z.string().optional(),
  best: z.boolean().optional(),
});
const WireNote = z.object({ kind: z.string().describe("tip|warning"), text: z.string() });
const WireOpen = z.object({ text: z.string(), day: z.number().int().optional() });
export const WirePlan = z.object({
  summary: z.string(),
  days: z.array(WireDay),
  notes: z.array(WireNote),
  open: z.array(WireOpen),
  packing: z.array(z.string()),
});
export const WirePatch = z.object({
  reply: z.string(),
  days: z.array(WireDay),
  summary: z.string().optional(),
  notes: z.array(WireNote).optional(),
  open: z.array(WireOpen).optional(),
});

const kinds = new Set<string>(ActivityKind.options);
const toDay = (d: z.infer<typeof WireDay>): LlmDay => ({
  ...d,
  stops: d.stops.map((s) => ({
    ...s,
    acts: s.acts.map((a) => ({ ...a, kind: (kinds.has(a.kind) ? a.kind : "do") as LlmDay["stops"][number]["acts"][number]["kind"] })),
  })),
});
const toNotes = (ns: z.infer<typeof WireNote>[]): LlmPlan["notes"] =>
  ns.map((n) => ({ kind: n.kind === "warning" ? "warning" : "tip", text: n.text }));

export function normalizePlan(w: z.infer<typeof WirePlan>): LlmPlan {
  return { ...w, days: w.days.map(toDay), notes: toNotes(w.notes) };
}
export function normalizePatch(w: z.infer<typeof WirePatch>): LlmPatch {
  const out: LlmPatch = { reply: w.reply, days: w.days.map(toDay) };
  if (w.summary !== undefined) out.summary = w.summary;
  if (w.notes !== undefined) out.notes = toNotes(w.notes);
  if (w.open !== undefined) out.open = w.open;
  return out;
}

export const inputBlock = (llm: PlanInput) => "INPUT\n" + canonicalJson(llm);

/** Generation request (exported for evals and tests). Only the system block is cached: the INPUT block can
 * only be reused by an identical generation, which the hash dedupe already prevents ([D13]). */
export function composeRequest(llm: PlanInput): StructuredRequest<typeof WirePlan> {
  return {
    task: "plan_generate",
    model: MODEL_PLAN,
    schema: WirePlan,
    effort: "medium",
    maxTokens: generateMaxTokens(llm.dayList.length),
    system: SYSTEM_RULES,
    blocks: [{ text: inputBlock(llm) }],
  };
}

export async function composePlan(llm: PlanInput, ctx: AiCtx): Promise<AiResult<LlmPlan>> {
  const r = await callStructured(composeRequest(llm), ctx);
  return r.ok ? { ...r, data: normalizePlan(r.data) } : r;
}

/** Model view of a stored day: refs as `p` ids (reverse index lookup), no date (dayList has it). */
function dayForModel(d: PlanDay, pid: Map<string, string>) {
  return {
    n: d.n,
    title: d.title,
    stops: d.stops.map((s) => ({
      ...s,
      acts: s.acts.map((a) => {
        const { ref, ...rest } = a;
        const id = ref ? pid.get(ref) : undefined;
        return id ? { ...rest, ref: id } : rest;
      }),
    })),
    note: d.note,
    warn: d.warn,
    best: d.best,
  };
}

/** Days the patch may touch: the feedback scope, or every day when the model decides. */
export function patchScope(feedback: PlanFeedback, totalDays: number): number[] {
  const s = [...new Set(feedback.days)].filter((n) => n >= 1 && n <= totalDays).sort((a, b) => a - b);
  return s.length ? s : Array.from({ length: totalDays }, (_, i) => i + 1);
}

/** CURRENT_PLAN + FEEDBACK blocks: scoped days in full, other days as title + refs only. */
export function patchBlocks(plan: Plan, index: PlanInputStored["index"], feedback: PlanFeedback) {
  const pid = new Map(Object.entries(index).map(([id, v]) => [v.key as string, id]));
  const scope = new Set(patchScope(feedback, plan.days.length));
  const days = plan.days.map((d) => {
    if (scope.has(d.n)) return dayForModel(d, pid);
    const refs = [...new Set(d.stops.flatMap((s) => s.acts.flatMap((a) => (a.ref && pid.get(a.ref) ? [pid.get(a.ref)!] : []))))];
    return { n: d.n, title: d.title, refs };
  });
  const current = { days, notes: plan.notes, open: plan.openItems };
  const fb = {
    do: feedback.chips.map((c) => CHIP_INSTRUCTIONS[c]),
    days: feedback.days.length ? [...scope] : undefined,
    text: feedback.text,
  };
  return ["CURRENT_PLAN\n" + canonicalJson(current), "FEEDBACK\n" + canonicalJson(fb)];
}

/** Patch request (exported for evals and tests). INPUT is cached for follow-up patches within 5 minutes. */
export function patchRequest(a: {
  llm: PlanInput;
  plan: Plan;
  index: PlanInputStored["index"];
  feedback: PlanFeedback;
}): StructuredRequest<typeof WirePatch> {
  const [current, fb] = patchBlocks(a.plan, a.index, a.feedback);
  return {
    task: "plan_patch",
    model: MODEL_PLAN,
    schema: WirePatch,
    effort: "medium", // low produced thin patch days in the live eval (2026-10-28)
    maxTokens: PATCH_MAX_TOKENS,
    system: SYSTEM_RULES + "\n\n" + PATCH_ADDENDUM,
    blocks: [{ text: inputBlock(a.llm), cache: true }, { text: current }, { text: fb }],
  };
}

export async function patchPlan(
  a: { llm: PlanInput; plan: Plan; index: PlanInputStored["index"]; feedback: PlanFeedback },
  ctx: AiCtx,
): Promise<AiResult<LlmPatch>> {
  const r = await callStructured(patchRequest(a), ctx);
  return r.ok ? { ...r, data: normalizePatch(r.data) } : r;
}
