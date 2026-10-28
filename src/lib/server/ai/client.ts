import "server-only";
import type { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AiCtx, AiModel, AiResult, AiTask } from "@/lib/domain/ai";
import { notImplemented } from "@/lib/plan/not-implemented";

/** Structured-output format for a Zod 4 schema (verified in client.test.ts, spec 4.2). */
export function outputFormat<S extends z.ZodType>(schema: S) {
  return zodOutputFormat(schema);
}

export type StructuredRequest<S extends z.ZodType> = {
  task: AiTask;
  model: AiModel;
  schema: S;
  effort: "low" | "medium";
  maxTokens: number;
  /** Cached system block. */
  system: string;
  /** User content blocks in order; `cache: true` adds an ephemeral cache breakpoint. */
  blocks: { text: string; cache?: boolean }[];
};

/**
 * One `messages.parse` call: stop_reason → refusal/max_tokens, null/invalid parse → invalid_output,
 * API error → ai_unavailable. Exactly one `ctx.onUsage` per call.
 */
export async function callStructured<S extends z.ZodType>(
  req: StructuredRequest<S>,
  ctx: AiCtx,
): Promise<AiResult<z.infer<S>>> {
  void req;
  void ctx;
  return notImplemented("callStructured");
}
