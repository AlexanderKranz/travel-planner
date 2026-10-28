import type Anthropic from "@anthropic-ai/sdk";

/** Model ids (spec 4.1). Part of the plan input hash: changing a model invalidates cached plans. */
export const MODEL_PLAN = "claude-sonnet-5-5";
export const MODEL_TAGS = "claude-haiku-5-5";
export type AiModel = typeof MODEL_PLAN | typeof MODEL_TAGS;

/** Bump when the system rules or the input/output shape change (part of the input hashes). */
export const PLAN_PROMPT_VERSION = "plan-3";
export const TAGS_PROMPT_VERSION = "tags-1";

/**
 * USD per 1M tokens (spec 4.4). tokens × price = micro-USD.
 * Cache write = 5-minute ephemeral cache.
 */
export const PRICES: Record<AiModel, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  [MODEL_PLAN]: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  [MODEL_TAGS]: { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
};

export type AiTask = "purpose_tags" | "plan_generate" | "plan_patch";
export type AiUsageStatus = "ok" | "refusal" | "max_tokens" | "invalid_output" | "error";

/** Metadata of one Claude call, logged to `ai_usage`. Never prompt or response content. */
export type AiUsageRecord = {
  task: AiTask;
  model: string;
  status: AiUsageStatus;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costMicroUsd: number;
  latencyMs: number;
  errorCode?: string;
};

export type AiCtx = {
  onUsage: (u: AiUsageRecord) => Promise<void>;
  /** Injected in tests/evals. */
  client?: Anthropic;
};

export type AiError = "ai_unavailable" | "ai_refused" | "invalid_output";
export type AiResult<T> =
  | { ok: true; data: T; usage: AiUsageRecord }
  | { ok: false; error: AiError; usage?: AiUsageRecord };
