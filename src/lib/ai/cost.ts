import { MODEL_PLAN, PRICES, type AiModel } from "@/lib/domain/ai";

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

const n = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);

/**
 * Micro-USD for one call (spec 4.4): tokens × USD-per-1M, rounded once.
 * `inputTokens` from the API excludes cached tokens, so the four parts never overlap.
 * Unknown models are priced like the plan model (the most expensive one), never as free.
 */
export function costMicroUsd(model: string, u: TokenUsage): number {
  const p = PRICES[model as AiModel] ?? PRICES[MODEL_PLAN];
  return Math.round(
    n(u.inputTokens) * p.input +
      n(u.outputTokens) * p.output +
      n(u.cacheCreationInputTokens) * p.cacheWrite +
      n(u.cacheReadInputTokens) * p.cacheRead,
  );
}
