import "server-only";
import { MODEL_TAGS, type AiCtx, type AiResult } from "@/lib/domain/ai";
import type { GroupParse } from "@/lib/domain/group-text";
import { normalizeParse, WireGroupParse } from "@/lib/group-text";
import { canonicalJson } from "@/lib/plan/hash";
import { GROUP_RULES } from "@/lib/plan/prompt";
import { callStructured, type StructuredRequest } from "./client";

export const GROUP_MAX_TOKENS = 800;

export function groupParseRequest(text: string): StructuredRequest<typeof WireGroupParse> {
  return {
    task: "group_parse",
    model: MODEL_TAGS,
    schema: WireGroupParse,
    effort: "low",
    maxTokens: GROUP_MAX_TOKENS,
    noThinking: true, // with thinking on, 3 of 6 live parses of a long group text ran out of tokens (2026-11-01)
    system: GROUP_RULES,
    blocks: [{ text: "TEXT\n" + canonicalJson({ text: text.trim() }) }],
  };
}

/** One Haiku call: group text -> validated travellers (our own safeParse, usage logged by `ctx.onUsage`). */
export async function parseGroupText(text: string, ctx: AiCtx): Promise<AiResult<GroupParse>> {
  const r = await callStructured(groupParseRequest(text), ctx);
  return r.ok ? { ...r, data: normalizeParse(r.data) } : r;
}
