import "server-only";
import { z } from "zod";
import { MODEL_IDEAS, type AiCtx, type AiResult } from "@/lib/domain/ai";
import { MAX_IDEAS } from "@/lib/domain/destination-search";
import { foldName } from "@/lib/discover/names";
import type { IdeaInput } from "@/lib/discover/input";
import { canonicalJson } from "@/lib/plan/hash";
import { IDEAS_RULES } from "@/lib/plan/prompt";
import { callStructured, type StructuredRequest } from "./client";

export const IDEAS_MAX_TOKENS = 1500;

/**
 * Wire schema: every field required (group-text D4: optional fields produced broken strings).
 * It has NO field for flights, routes, prices, hours or distances, and it must stay that way (ground rule 1).
 */
export const WireIdea = z.object({
  name: z.string(), // display name in lang: "Costa del Sol", "Mallorca", "Lissabon"
  anchor: z.string(), // one real town that can be geocoded: "Marbella", "Palma", "Lisboa"
  cc: z.string(), // ISO 3166-1 alpha-2
  reason: z.string(), // one sentence, in lang
});
export const WireIdeas = z.object({ ideas: z.array(WireIdea) });
export type WireIdea = z.infer<typeof WireIdea>;

/** An idea after trimming; `reason` is still raw (cleaned by `cleanReason` when the card is built). */
export type Idea = { name: string; anchor: string; cc: string; reason: string };

/**
 * Trims, drops unusable entries (no anchor, cc not 2 letters), anchors repeated or listed in `exclude`, and keeps
 * at most 8.
 */
export function normalizeIdeas(w: z.infer<typeof WireIdeas>, exclude: readonly string[] = []): Idea[] {
  const seen = new Set(exclude.map(foldName));
  const out: Idea[] = [];
  for (const i of w.ideas) {
    const anchor = i.anchor.replace(/\s+/g, " ").trim().slice(0, 120);
    const cc = i.cc.trim().toUpperCase();
    const name = i.name.replace(/\s+/g, " ").trim().slice(0, 80) || anchor;
    if (!anchor || !/^[A-Z]{2}$/.test(cc)) continue;
    const key = foldName(anchor);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, anchor, cc, reason: i.reason });
    if (out.length >= MAX_IDEAS) break;
  }
  return out;
}

export function ideasRequest(input: IdeaInput): StructuredRequest<typeof WireIdeas> {
  return {
    task: "destination_ideas",
    model: MODEL_IDEAS,
    schema: WireIdeas,
    effort: "low",
    maxTokens: IDEAS_MAX_TOKENS,
    system: IDEAS_RULES,
    blocks: [{ text: "INPUT\n" + canonicalJson(input) }],
  };
}

/** One call: purpose + context -> up to 8 validated ideas (usage logged through `ctx.onUsage`). */
export async function proposeIdeas(input: IdeaInput, ctx: AiCtx): Promise<AiResult<Idea[]>> {
  const r = await callStructured(ideasRequest(input), ctx);
  return r.ok ? { ...r, data: normalizeIdeas(r.data, input.exclude) } : r;
}
