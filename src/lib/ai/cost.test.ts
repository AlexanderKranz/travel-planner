import { describe, expect, it } from "vitest";
import { MODEL_PLAN, MODEL_TAGS } from "@/lib/domain/ai";
import { costMicroUsd } from "./cost";

const u = (i: number, o: number, cw = 0, cr = 0) => ({ inputTokens: i, outputTokens: o, cacheCreationInputTokens: cw, cacheReadInputTokens: cr });

describe("costMicroUsd", () => {
  it("prices Sonnet: $2 in, $10 out, 1.25x write, 0.1x read per 1M", () => {
    expect(costMicroUsd(MODEL_PLAN, u(1_000_000, 0))).toBe(2_000_000);
    expect(costMicroUsd(MODEL_PLAN, u(0, 1000))).toBe(10_000);
    expect(costMicroUsd(MODEL_PLAN, u(2143, 1579, 2361, 0))).toBe(25_979); // live golf generation (25 978.5 rounded once)
    expect(costMicroUsd(MODEL_PLAN, u(0, 0, 0, 2408))).toBe(482);
  });

  it("prices Haiku with cache fields", () => {
    expect(costMicroUsd(MODEL_TAGS, u(192, 218, 916, 0))).toBe(243); // live golf tags
    expect(costMicroUsd(MODEL_TAGS, u(117, 158, 0, 916))).toBe(100);
  });

  it("never prices an unknown model as free and ignores bad numbers", () => {
    expect(costMicroUsd("claude-unknown", u(1000, 0))).toBe(2000);
    expect(costMicroUsd(MODEL_PLAN, u(-5, Number.NaN))).toBe(0);
  });
});
