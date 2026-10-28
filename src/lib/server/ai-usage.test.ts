import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  rows: [] as { user_id: string | null; cost_micro_usd: number }[],
  inserted: [] as unknown[],
  readError: false,
  insertError: false,
}));
vi.mock("./supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: () => ({
      insert: async (row: unknown) => {
        h.inserted.push(row);
        if (h.insertError) throw new Error("boom");
        return { error: null };
      },
    }),
    rpc: async (_fn: string, args: { p_user: string }) => {
      if (h.readError) return { data: null, error: { code: "x" } };
      const sum = (rs: typeof h.rows) => rs.reduce((t, r) => t + r.cost_micro_usd, 0);
      return { data: [{ user_spent: sum(h.rows.filter((r) => r.user_id === args.p_user)), global_spent: sum(h.rows) }], error: null };
    },
  }),
}));

import {
  berlinMidnight,
  budgetAllows,
  getBudgetStatus,
  globalCapMicroUsd,
  isAiEnabled,
  logAiUsage,
  userCapMicroUsd,
} from "./ai-usage";

describe("berlinMidnight", () => {
  it("winter (CET, +1)", () => {
    const now = new Date("2026-10-28T12:00:00Z");
    expect(berlinMidnight(now).toISOString()).toBe("2026-10-27T23:00:00.000Z");
    expect(berlinMidnight(now, 1).toISOString()).toBe("2026-10-28T23:00:00.000Z");
  });
  it("summer (CEST, +2)", () => {
    expect(berlinMidnight(new Date("2026-07-15T10:00:00Z")).toISOString()).toBe("2026-07-14T22:00:00.000Z");
  });
  it("boundary: 22:59Z is still the same Berlin day in winter, 23:00Z starts the next", () => {
    expect(berlinMidnight(new Date("2026-12-10T22:59:59Z")).toISOString()).toBe("2026-12-09T23:00:00.000Z");
    expect(berlinMidnight(new Date("2026-12-10T23:00:00Z")).toISOString()).toBe("2026-12-10T23:00:00.000Z");
  });
  it("DST switch days (2026-03-29 spring forward, 2026-10-25 fall back)", () => {
    // Berlin midnight of 29 Mar is still CET; the next midnight is CEST.
    expect(berlinMidnight(new Date("2026-03-29T12:00:00Z")).toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(berlinMidnight(new Date("2026-03-29T12:00:00Z"), 1).toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(berlinMidnight(new Date("2026-10-25T12:00:00Z")).toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(berlinMidnight(new Date("2026-10-25T12:00:00Z"), 1).toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });
});

describe("caps", () => {
  it("defaults per role and demo", () => {
    expect(userCapMicroUsd("user", false, {})).toBe(500_000);
    expect(userCapMicroUsd("admin", false, {})).toBe(2_000_000);
    expect(userCapMicroUsd("user", true, {})).toBe(200_000);
    expect(userCapMicroUsd("admin", true, {})).toBe(200_000); // demo wins
    expect(globalCapMicroUsd({})).toBe(5_000_000);
  });
  it("env overrides, invalid values fall back", () => {
    expect(userCapMicroUsd("user", false, { AI_USER_DAILY_USD: "1.25" })).toBe(1_250_000);
    expect(userCapMicroUsd("user", false, { AI_USER_DAILY_USD: "abc" })).toBe(500_000);
    expect(userCapMicroUsd("user", false, { AI_USER_DAILY_USD: "-1" })).toBe(500_000);
    expect(userCapMicroUsd("user", false, { AI_USER_DAILY_USD: "0" })).toBe(0);
    expect(globalCapMicroUsd({ AI_GLOBAL_DAILY_USD: "10" })).toBe(10_000_000);
  });
  it("kill switch needs the exact value and a key", () => {
    expect(isAiEnabled({})).toBe(false);
    expect(isAiEnabled({ AI_ENABLED: "true" })).toBe(false);
    expect(isAiEnabled({ ANTHROPIC_API_KEY: "k" })).toBe(false);
    expect(isAiEnabled({ AI_ENABLED: "1", ANTHROPIC_API_KEY: "k" })).toBe(false);
    expect(isAiEnabled({ AI_ENABLED: "true", ANTHROPIC_API_KEY: "k" })).toBe(true);
  });
});

describe("getBudgetStatus / budgetAllows", () => {
  beforeEach(() => {
    h.rows = [
      { user_id: "u1", cost_micro_usd: 100_000 },
      { user_id: "u1", cost_micro_usd: 50_000 },
      { user_id: "u2", cost_micro_usd: 300_000 },
    ];
    h.inserted = [];
    h.readError = false;
    h.insertError = false;
  });
  const now = new Date("2026-10-28T12:00:00Z");
  it("sums user and global spend and reports the reset", async () => {
    const info = await getBudgetStatus("u1", "user", false, now, {});
    expect(info).toMatchObject({
      spentMicroUsd: 150_000,
      capMicroUsd: 500_000,
      globalSpentMicroUsd: 450_000,
      globalCapMicroUsd: 5_000_000,
      resetsAt: "2026-10-28T23:00:00.000Z",
    });
  });
  it("user cap with reserve", async () => {
    const info = await getBudgetStatus("u1", "user", false, now, {});
    expect(budgetAllows(info, 150_000)).toBe(true); // 150k + 150k <= 500k
    expect(budgetAllows(info, 350_001)).toBe(false);
  });
  it("global cap blocks everyone", async () => {
    const info = await getBudgetStatus("u1", "user", false, now, { AI_GLOBAL_DAILY_USD: "0.5" });
    expect(budgetAllows(info, 50_001)).toBe(false);
    expect(budgetAllows(info, 50_000)).toBe(true);
  });
  it("demo cap is lower", async () => {
    const info = await getBudgetStatus("u1", "user", true, now, {});
    expect(info.capMicroUsd).toBe(200_000);
    expect(budgetAllows(info, 150_000)).toBe(false);
  });
  it("a read error propagates (callers fail closed)", async () => {
    h.readError = true;
    await expect(getBudgetStatus("u1", "user", false, now, {})).rejects.toThrow();
  });
  it("logAiUsage writes metadata only and never throws", async () => {
    const rec = { task: "plan_generate", model: "claude-sonnet-5-5", status: "ok", inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4, costMicroUsd: 5, latencyMs: 6, errorCode: "x" } as const;
    await logAiUsage("u1", true, rec);
    expect(h.inserted[0]).toEqual({
      user_id: "u1", task: "plan_generate", model: "claude-sonnet-5-5", status: "ok", input_tokens: 1, output_tokens: 2,
      cache_creation_input_tokens: 3, cache_read_input_tokens: 4, cost_micro_usd: 5, latency_ms: 6, is_demo: true, error_code: "x",
    });
    h.insertError = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(logAiUsage("u1", false, rec)).resolves.toBeUndefined();
  });
});
