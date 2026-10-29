import { describe, expect, it } from "vitest";
import { evaluateBudget, type BudgetMetrics } from "./budget";
import type { BudgetConfig } from "./config";

const cfg: BudgetConfig = { aiDailyCapMicroUsd: 5_000_000, aiMonthlyAlertMicroUsd: 10_000_000, adbDailyUnits: 40, adbMinRemaining: 40, orsDailyCap: 400, errors24hThreshold: 20 };
const calm: BudgetMetrics = { aiTodayMicroUsd: 0, aiMonthMicroUsd: 0, adbRemaining: 300, orsRequestsToday: 0, errors24h: 0 };
const kinds = (m: Partial<BudgetMetrics>, c = cfg) => evaluateBudget({ ...calm, ...m }, c).map((a) => `${a.kind}:${a.level}`);

describe("evaluateBudget", () => {
  it("is silent when everything is within budget", () => {
    expect(kinds({})).toEqual([]);
  });
  it("AI daily: warn at 80 %, error at the cap", () => {
    expect(kinds({ aiTodayMicroUsd: 3_999_999 })).toEqual([]);
    expect(kinds({ aiTodayMicroUsd: 4_000_000 })).toEqual(["ai_daily:warn"]);
    expect(kinds({ aiTodayMicroUsd: 5_000_000 })).toEqual(["ai_daily:error"]);
  });
  it("AI monthly uses AI_MONTHLY_ALERT_USD", () => {
    expect(kinds({ aiMonthMicroUsd: 8_000_000 })).toEqual(["ai_monthly:warn"]);
    expect(kinds({ aiMonthMicroUsd: 8_000_000 }, { ...cfg, aiMonthlyAlertMicroUsd: 20_000_000 })).toEqual([]);
  });
  it("AeroDataBox: warn below 2x the margin, error below the margin, silent when unknown", () => {
    expect(kinds({ adbRemaining: 80 })).toEqual([]);
    expect(kinds({ adbRemaining: 79 })).toEqual(["aerodatabox_monthly:warn"]);
    expect(kinds({ adbRemaining: 39 })).toEqual(["aerodatabox_monthly:error"]);
    expect(kinds({ adbRemaining: null })).toEqual([]);
  });
  it("ORS daily: warn at 80 % of the cap", () => {
    expect(kinds({ orsRequestsToday: 319 })).toEqual([]);
    expect(kinds({ orsRequestsToday: 320 })).toEqual(["ors_daily:warn"]);
    expect(kinds({ orsRequestsToday: 400 })).toEqual(["ors_daily:error"]);
  });
  it("errors in 24 h: only above the threshold", () => {
    expect(kinds({ errors24h: 20 })).toEqual([]);
    expect(kinds({ errors24h: 21 })).toEqual(["errors_24h:warn"]);
    expect(kinds({ errors24h: 41 })).toEqual(["errors_24h:error"]);
  });
  it("a zero cap disables that check", () => {
    expect(kinds({ aiTodayMicroUsd: 1, orsRequestsToday: 5 }, { ...cfg, aiDailyCapMicroUsd: 0, orsDailyCap: 0 })).toEqual([]);
  });
  it("alert props are numbers only", () => {
    const [a] = evaluateBudget({ ...calm, aiTodayMicroUsd: 4_500_000 }, cfg);
    expect(a.props).toEqual({ used: 4_500_000, cap: 5_000_000, pct: 90 });
  });
});
