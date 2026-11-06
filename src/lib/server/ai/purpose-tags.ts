import "server-only";
import { z } from "zod";
import { MODEL_TAGS, type AiCtx, type AiResult } from "@/lib/domain/ai";
import { INTEREST_KEYS } from "@/lib/domain/interests";
import { MAX_ACTIVITY_WISHES, PurposeTags } from "@/lib/domain/plan";
import { ACTIVITY_GROUPS, ACTIVITY_TYPES, ActivityGroup, isActivityType } from "@/lib/facts/activity-types";
import { CUISINES, type Cuisine } from "@/lib/facts/cuisine";
import type { TripPurpose } from "@/lib/domain/purpose";
import { isInterestKey } from "@/lib/facts/interest-sources";
import { withFamilyFallback } from "@/lib/plan/family-mention";
import { canonicalJson, customGuidedInterests } from "@/lib/plan/hash";
import { TAGS_RULES } from "@/lib/plan/prompt";
import { callStructured, type StructuredRequest } from "./client";

export const TAGS_MAX_TOKENS = 3000; // tags-2 with thinking used 1377-1500 output tokens for a long purpose (live eval 2026-11-06)
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
  activities: z
    .array(
      z.object({
        types: z.array(z.string().describe(ACTIVITY_TYPES.join("|"))),
        open: z.boolean(),
        group: z.string().describe(ACTIVITY_GROUPS.join("|")).optional(),
        label: z.string().optional(),
      }),
    )
    .optional(),
  cuisine: z.object({ local: z.boolean(), include: z.array(z.string()), exclude: z.array(z.string()), kids: z.boolean().optional() }).optional(),
  cafes: z.boolean().optional(),
});
const MAX_LABEL_CHARS = 60;

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
    v: 2,
    interests: [...new Set(w.interests.map((i) => i.trim()).filter(isInterestKey))],
    custom: clean(w.custom).slice(0, 10),
    ...(pace ? { pace } : {}),
    hard: clean(w.hard),
    soft: clean(w.soft),
    summary: w.summary.replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY_CHARS),
    ...activitiesOf(w.activities),
    ...cuisineOf(w.cuisine),
    ...(w.cafes === true ? { cafes: true as const } : {}),
  });
}

/**
 * Activity wishes (spec section 2): unknown types and groups are dropped; an entry without types and without a
 * valid group has nothing to load and is dropped; with types, `group` is ignored. An entry with only a group means
 * "something of this kind", so it counts as open.
 */
function activitiesOf(ws: z.infer<typeof WireTags>["activities"]): Pick<PurposeTags, "activities"> {
  const out: NonNullable<PurposeTags["activities"]> = [];
  for (const w of ws ?? []) {
    const types = [...new Set(w.types.map((t) => t.trim()).filter(isActivityType))];
    const g = ActivityGroup.safeParse(w.group?.trim());
    if (!types.length && !g.success) continue;
    const label = w.label?.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_CHARS);
    out.push({
      types,
      open: types.length ? w.open : true,
      ...(types.length || !g.success ? {} : { group: g.data }),
      ...(label ? { label } : {}),
    });
  }
  return out.length ? { activities: out.slice(0, MAX_ACTIVITY_WISHES) } : {};
}

const cuisines = (xs: string[]): Cuisine[] => [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(isCuisine))];
const isCuisine = (c: string): c is Cuisine => (CUISINES as readonly string[]).includes(c);

function cuisineOf(c: z.infer<typeof WireTags>["cuisine"]): Pick<PurposeTags, "cuisine"> {
  if (!c) return {};
  const include = cuisines(c.include);
  const exclude = cuisines(c.exclude).filter((x) => !include.includes(x));
  // `kids` only when set: an explicit ask for child-friendly places (addendum A4), never inferred from the group.
  const kids = c.kids === true;
  return c.local || include.length || exclude.length || kids ? { cuisine: { local: c.local, include, exclude, ...(kids ? { kids } : {}) } } : {};
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

/** Wire tags → stored tags: normalizeTags, then the deterministic family fallback on the user's text (issue #142). */
export function finishTags(w: z.infer<typeof WireTags>, p: Pick<TripPurpose, "text" | "constraints">): PurposeTags {
  return withFamilyFallback(normalizeTags(w), [p.text, ...p.constraints]);
}

export async function tagPurpose(p: TripPurpose, ctx: AiCtx): Promise<AiResult<PurposeTags>> {
  const r = await callStructured(tagsRequest(p), ctx);
  return r.ok ? { ...r, data: finishTags(r.data, p) } : r;
}
