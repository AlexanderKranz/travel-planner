import "server-only";
import { z } from "zod";
import { MODEL_TAGS, type AiCtx, type AiResult } from "@/lib/domain/ai";
import { INTEREST_KEYS } from "@/lib/domain/interests";
import { PurposeTags } from "@/lib/domain/plan";
import type { TripPurpose } from "@/lib/domain/purpose";
import { isInterestKey } from "@/lib/facts/interest-sources";
import { canonicalJson, customGuidedInterests } from "@/lib/plan/hash";
import { TAGS_RULES } from "@/lib/plan/prompt";
import { callStructured, type StructuredRequest } from "./client";

export const TAGS_MAX_TOKENS = 1500;
const MAX_ITEMS = 30;
const MAX_ITEM_CHARS = 200;
const MAX_SUMMARY_CHARS = 300;

/** True when the purpose has text, constraints or custom interests. Hash comparison is the caller's. */
export function needsTags(p: TripPurpose): boolean {
  return !!p.text?.trim() || p.constraints.length > 0 || customGuidedInterests(p).length > 0;
}

// Lenient wire schema: unknown interest keys are dropped in code instead of failing the call.
const WireTags = z.object({
  v: z.number(),
  interests: z.array(z.string().describe(INTEREST_KEYS.join("|"))),
  custom: z.array(z.string()),
  pace: z.string().describe("relaxed|balanced|packed").optional(),
  hard: z.array(z.string()),
  soft: z.array(z.string()),
  summary: z.string(),
});

const clean = (xs: string[]) => {
  const out: string[] = [];
  for (const x of xs) {
    const t = x.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_CHARS);
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out.slice(0, MAX_ITEMS);
};

export function normalizeTags(w: z.infer<typeof WireTags>): PurposeTags {
  const pace = w.pace === "relaxed" || w.pace === "balanced" || w.pace === "packed" ? w.pace : undefined;
  return PurposeTags.parse({
    v: 1,
    interests: [...new Set(w.interests.map((i) => i.trim()).filter(isInterestKey))],
    custom: clean(w.custom).slice(0, 10),
    ...(pace ? { pace } : {}),
    hard: clean(w.hard),
    soft: clean(w.soft),
    summary: w.summary.replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY_CHARS),
  });
}

export function tagsRequest(p: TripPurpose): StructuredRequest<typeof WireTags> {
  const purpose = { text: p.text?.trim() || undefined, constraints: p.constraints, custom: customGuidedInterests(p) };
  return {
    task: "purpose_tags",
    model: MODEL_TAGS,
    schema: WireTags,
    effort: "low",
    maxTokens: TAGS_MAX_TOKENS,
    system: TAGS_RULES,
    blocks: [{ text: "PURPOSE\n" + canonicalJson(purpose) }],
  };
}

export async function tagPurpose(p: TripPurpose, ctx: AiCtx): Promise<AiResult<PurposeTags>> {
  const r = await callStructured(tagsRequest(p), ctx);
  return r.ok ? { ...r, data: normalizeTags(r.data) } : r;
}
