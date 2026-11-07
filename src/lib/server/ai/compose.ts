import "server-only";
import { z } from "zod";
import { MODEL_PLAN, type AiCtx, type AiResult } from "@/lib/domain/ai";
import { ActivityKind, type LlmDay, type LlmPatch, type LlmPlan, type NeedPlaces, type Plan, type PlanDay, type PlanFeedback } from "@/lib/domain/plan";
import { ACTIVITY_TYPES, isActivityType } from "@/lib/facts/activity-types";
import { CUISINES, type Cuisine } from "@/lib/facts/cuisine";
import { MAX_INTEREST_QUERIES, PLACE_INTEREST_KEYS, isPlaceInterest } from "@/lib/facts/interest-sources";
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
  alts: z.array(z.string()).optional(),
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
/**
 * Patch wire schema. The API allows at most 24 optional parameters per structured-output schema (HTTP 400 above);
 * this one has 22 (unit test asserts <= 23). Prefer required fields with a neutral value (`kids: false`, `near: ""`)
 * over new optional ones.
 */
export const WirePatch = z.object({
  reply: z.string(),
  days: z.array(WireDay),
  summary: z.string().optional(),
  notes: z.array(WireNote).optional(),
  open: z.array(WireOpen).optional(),
  needPlaces: z
    .object({
      // Activity types and place interests (issue #151) share one field: no extra optional parameter.
      types: z.array(z.string().describe([...ACTIVITY_TYPES, ...PLACE_INTEREST_KEYS].join("|"))).optional(),
      restaurants: z
        .object({
          cuisine: z
            // kids is required (false = not asked): the API allows at most 24 optional parameters per schema.
            .object({ local: z.boolean().optional(), include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional(), kids: z.boolean() })
            .optional(),
          near: z.string().optional(),
        })
        .optional(),
      cafes: z.object({ near: z.string().describe("place id or empty"), kids: z.boolean() }).optional(),
    })
    .optional(),
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
  const need = needPlacesOf(w.needPlaces);
  if (need) out.needPlaces = need;
  // The model asked for places the app cannot load (unknown kinds): its "I will load them" reply must not reach the user.
  else if (w.needPlaces) out.needPlacesUnusable = true;
  return out;
}

const isCuisine = (c: string): c is Cuisine => (CUISINES as readonly string[]).includes(c);
const cuisineList = (xs: string[] | undefined) => [...new Set((xs ?? []).map((x) => x.trim().toLowerCase()).filter(isCuisine))];

/**
 * Wire needPlaces -> NeedPlaces with only catalogue types, place interests (source osm, at most
 * MAX_INTEREST_QUERIES) and known cuisines; undefined when nothing is left.
 */
function needPlacesOf(n: z.infer<typeof WirePatch>["needPlaces"]): NeedPlaces | undefined {
  if (!n) return undefined;
  const raw = [...new Set((n.types ?? []).map((t) => t.trim()))];
  const types = raw.filter(isActivityType);
  const interests = raw.filter(isPlaceInterest).slice(0, MAX_INTEREST_QUERIES);
  const out: NeedPlaces = {};
  if (types.length) out.types = types;
  if (interests.length) out.interests = interests;
  if (n.restaurants) {
    const c = n.restaurants.cuisine;
    const include = cuisineList(c?.include);
    const exclude = cuisineList(c?.exclude);
    const kids = c?.kids === true;
    out.restaurants = {
      // `local` only when the model set it, so extendInput can keep the earlier wish otherwise.
      ...(c && (c.local !== undefined || include.length || exclude.length || kids)
        ? { cuisine: { ...(c.local !== undefined ? { local: c.local } : {}), include, exclude, ...(kids ? { kids } : {}) } }
        : {}),
      ...(n.restaurants.near?.trim() ? { near: n.restaurants.near.trim() } : {}),
    };
  }
  if (n.cafes) {
    out.cafes = { ...(n.cafes.kids === true ? { kids: true } : {}), ...(n.cafes.near?.trim() ? { near: n.cafes.near.trim() } : {}) };
  }
  return out.types || out.interests || out.restaurants || out.cafes ? out : undefined;
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
        const { ref, alts, ...rest } = a;
        const id = ref ? pid.get(ref) : undefined;
        const altIds = (alts ?? []).flatMap((k) => (pid.get(k) ? [pid.get(k)!] : []));
        return id ? { ...rest, ref: id, ...(altIds.length ? { alts: altIds } : {}) } : rest;
      }),
    })),
    note: d.note,
    warn: d.warn,
  };
}

/** Days the patch may touch: the feedback scope, or every day when the model decides. */
export function patchScope(feedback: PlanFeedback, totalDays: number): number[] {
  const s = [...new Set(feedback.days)].filter((n) => n >= 1 && n <= totalDays).sort((a, b) => a - b);
  return s.length ? s : Array.from({ length: totalDays }, (_, i) => i + 1);
}

/** CURRENT_PLAN + FEEDBACK blocks: scoped days in full, other days as title + refs only. */
export function patchBlocks(
  plan: Plan,
  index: PlanInputStored["index"],
  feedback: PlanFeedback,
  fixed?: { now: PlanInput["fixed"]; input: PlanInput["fixed"] },
  loaded?: boolean,
) {
  const pid = new Map(Object.entries(index).map(([id, v]) => [v.key as string, id]));
  const scope = new Set(patchScope(feedback, plan.days.length));
  const days = plan.days.map((d) => {
    if (scope.has(d.n)) return dayForModel(d, pid);
    const refs = [...new Set(d.stops.flatMap((s) => s.acts.flatMap((a) => (a.ref && pid.get(a.ref) ? [pid.get(a.ref)!] : []))))];
    return { n: d.n, title: d.title, refs };
  });
  // Items changed since INPUT was built: the current fixed slots go here ([] = all removed); INPUT stays cached.
  const changed = fixed && canonicalJson(fixed.now ?? []) !== canonicalJson(fixed.input ?? []);
  const current = { days, notes: plan.notes, open: plan.openItems, ...(changed ? { fixed: fixed.now ?? [] } : {}) };
  const fb = {
    do: feedback.chips.map((c) => CHIP_INSTRUCTIONS[c]),
    days: feedback.days.length ? [...scope] : undefined,
    text: feedback.text,
    // Second call after code loaded the places the first one asked for: needPlaces is not allowed again.
    ...(loaded ? { loaded: true } : {}),
  };
  return ["CURRENT_PLAN\n" + canonicalJson(current), "FEEDBACK\n" + canonicalJson(fb)];
}

/** Patch request (exported for evals and tests). INPUT is cached for follow-up patches within 5 minutes. */
export function patchRequest(a: {
  llm: PlanInput;
  plan: Plan;
  index: PlanInputStored["index"];
  feedback: PlanFeedback;
  /** Current fixed slots; sent only when they differ from `llm.fixed`. */
  fixed?: PlanInput["fixed"];
  /** Second call after needPlaces (FEEDBACK.loaded = true). */
  loaded?: boolean;
  /** Client timeout for this call (the iterate deadline); default CLIENT_TIMEOUT_MS. */
  timeoutMs?: number;
}): StructuredRequest<typeof WirePatch> {
  const [current, fb] = patchBlocks(a.plan, a.index, a.feedback, "fixed" in a ? { now: a.fixed, input: a.llm.fixed } : undefined, a.loaded);
  return {
    task: "plan_patch",
    model: MODEL_PLAN,
    schema: WirePatch,
    effort: "medium", // low produced thin patch days in the live eval (2026-10-28)
    maxTokens: PATCH_MAX_TOKENS,
    system: SYSTEM_RULES + "\n\n" + PATCH_ADDENDUM,
    blocks: [{ text: inputBlock(a.llm), cache: true }, { text: current }, { text: fb }],
    ...(a.timeoutMs ? { timeoutMs: a.timeoutMs } : {}),
  };
}

export async function patchPlan(
  a: Parameters<typeof patchRequest>[0],
  ctx: AiCtx,
): Promise<AiResult<LlmPatch>> {
  const r = await callStructured(patchRequest(a), ctx);
  if (!r.ok) return r;
  const data = normalizePatch(r.data);
  // The second call cannot request places again (spec section 4): code drops a repeated request and flags it,
  // so a reply like "I will load them" is never shown.
  if (a.loaded && data.needPlaces) {
    delete data.needPlaces;
    data.needPlacesUnusable = true;
  }
  return { ...r, data };
}
