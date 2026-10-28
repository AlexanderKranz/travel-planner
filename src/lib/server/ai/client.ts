import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AiCtx, AiModel, AiResult, AiTask, AiUsageRecord, AiUsageStatus } from "@/lib/domain/ai";
import { costMicroUsd } from "@/lib/ai/cost";

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
 * One attempt, no SDK retries: 140 s stays well inside the route's maxDuration (300 s) and the 5-minute plan lock.
 * A retry would double a possibly billed call without ever being logged.
 */
export const CLIENT_TIMEOUT_MS = 140_000;
export const CLIENT_MAX_RETRIES = 0;

let shared: Anthropic | null = null;
function defaultClient(): Anthropic {
  shared ??= new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: CLIENT_TIMEOUT_MS,
    maxRetries: CLIENT_MAX_RETRIES,
  });
  return shared;
}

/**
 * Conservative cost for a failed call whose usage the API never returned (timeout, 5xx, network):
 * the whole prompt (system + blocks, ~4 chars per token) billed once at the uncached input price, output at 0.
 * Input is the part we can bound from our side; output of an aborted call is unknown, and charging max_tokens
 * would block the budget after a few outages. Token columns stay 0 (they are not measured); only the cost is
 * estimated (at least 1 µUSD), so the daily budget still counts the attempt.
 */
export function estimateFailedCostMicroUsd(req: Pick<StructuredRequest<z.ZodType>, "model" | "system" | "blocks">): number {
  const chars = req.system.length + req.blocks.reduce((sum, b) => sum + b.text.length, 0);
  const cost = costMicroUsd(req.model, {
    inputTokens: Math.ceil(chars / 4),
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  });
  return Math.max(1, cost);
}

/** Short error class for `ai_usage.error_code` (never a message). */
export function errorCode(e: unknown): string {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (e instanceof Anthropic.APIUserAbortError) return "aborted";
  if (e instanceof Anthropic.APIConnectionError) return "network";
  if (e instanceof Anthropic.APIError && typeof e.status === "number") return `http_${e.status}`;
  return "unknown";
}

/**
 * One structured call (spec 4.2). Uses `messages.create` with the JSON schema from `zodOutputFormat` and parses
 * the text itself with `schema.safeParse`, so a Zod failure keeps the (billed) usage for `ai_usage`;
 * `messages.parse` would throw it away. Order: API error → ai_unavailable; stop_reason refusal → ai_refused;
 * max_tokens → invalid_output; JSON/Zod failure → invalid_output. Exactly one `ctx.onUsage` per call.
 * No prefill, no thinking parameter (adaptive by default), no abort signal (the server finishes and saves).
 */
export async function callStructured<S extends z.ZodType>(
  req: StructuredRequest<S>,
  ctx: AiCtx,
): Promise<AiResult<z.infer<S>>> {
  const client = ctx.client ?? defaultClient();
  const started = Date.now();
  const record = (
    status: AiUsageStatus,
    u?: Anthropic.Usage | null,
    code?: string,
  ): AiUsageRecord => {
    const tokens = {
      inputTokens: u?.input_tokens ?? 0,
      outputTokens: u?.output_tokens ?? 0,
      cacheCreationInputTokens: u?.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: u?.cache_read_input_tokens ?? 0,
    };
    const r: AiUsageRecord = {
      task: req.task,
      model: req.model,
      status,
      ...tokens,
      costMicroUsd: costMicroUsd(req.model, tokens),
      latencyMs: Date.now() - started,
    };
    if (code) r.errorCode = code;
    return r;
  };
  const report = async (r: AiUsageRecord) => {
    try {
      await ctx.onUsage(r);
    } catch {
      // Logging must never break the call.
    }
  };

  const { schema: jsonSchema } = outputFormat(req.schema);
  let msg: Anthropic.Message;
  try {
    msg = await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: req.blocks.map((b) =>
            b.cache
              ? { type: "text" as const, text: b.text, cache_control: { type: "ephemeral" as const } }
              : { type: "text" as const, text: b.text },
          ),
        },
      ],
      output_config: { format: { type: "json_schema", schema: jsonSchema }, effort: req.effort },
    });
  } catch (e) {
    const usage = record("error", null, errorCode(e));
    usage.costMicroUsd = estimateFailedCostMicroUsd(req);
    await report(usage);
    return { ok: false, error: "ai_unavailable", usage };
  }

  if (msg.stop_reason === "refusal") {
    const usage = record("refusal", msg.usage, "refusal");
    await report(usage);
    return { ok: false, error: "ai_refused", usage };
  }
  if (msg.stop_reason === "max_tokens") {
    const usage = record("max_tokens", msg.usage, "max_tokens");
    await report(usage);
    return { ok: false, error: "invalid_output", usage };
  }
  const text = [...msg.content].reverse().find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  let data: unknown;
  try {
    data = text === undefined ? undefined : JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (data === undefined) {
    const usage = record("invalid_output", msg.usage, "json");
    await report(usage);
    return { ok: false, error: "invalid_output", usage };
  }
  const parsed = req.schema.safeParse(data);
  if (!parsed.success) {
    const usage = record("invalid_output", msg.usage, "zod");
    await report(usage);
    return { ok: false, error: "invalid_output", usage };
  }
  const usage = record("ok", msg.usage);
  await report(usage);
  return { ok: true, data: parsed.data as z.infer<S>, usage };
}
