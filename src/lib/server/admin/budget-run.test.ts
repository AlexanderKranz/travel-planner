import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), flush: vi.fn() }));
vi.mock("../supabase/admin", () => ({ createSupabaseAdminClient: () => ({}) }));

import type { BudgetConfig } from "./config";
import { runBudgetCheck, type BudgetDeps } from "./budget-run";

const config: BudgetConfig = { aiDailyCapMicroUsd: 5_000_000, aiMonthlyAlertMicroUsd: 10_000_000, adbDailyUnits: 40, adbMinRemaining: 40, orsDailyCap: 400, errors24hThreshold: 20 };
const metrics = { aiTodayMicroUsd: 4_500_000, aiMonthMicroUsd: 1, adbRemaining: 50, orsRequestsToday: 0, errors24h: 30 };

function deps(over: Partial<BudgetDeps> = {}): BudgetDeps & { deliver: ReturnType<typeof vi.fn>; logRun: ReturnType<typeof vi.fn> } {
  return {
    config,
    readMetrics: vi.fn().mockResolvedValue(metrics),
    alreadySent: vi.fn().mockResolvedValue(false),
    deliver: vi.fn().mockResolvedValue(undefined),
    logRun: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as never;
}

describe("runBudgetCheck", () => {
  const now = new Date("2026-10-29T20:30:00Z");

  it("delivers each triggered alert once and logs the run", async () => {
    const d = deps();
    const r = await runBudgetCheck(now, d);
    expect(r.alerts.map((a) => `${a.kind}:${a.sent}`)).toEqual(["ai_daily:true", "aerodatabox_monthly:true", "errors_24h:true"]);
    expect(d.deliver).toHaveBeenCalledTimes(3);
    expect(d.deliver.mock.calls[0][1]).toBe("2026-10-29");
    expect(d.logRun).toHaveBeenCalledWith({ alerts: 3, sent: 3 });
  });

  it("dedupe: a kind already alerted today is not sent again", async () => {
    const d = deps({ alreadySent: vi.fn(async (kind) => kind === "ai_daily") });
    const r = await runBudgetCheck(now, d);
    expect(r.alerts.find((a) => a.kind === "ai_daily")?.sent).toBe(false);
    expect(d.deliver).toHaveBeenCalledTimes(2);
    expect(d.logRun).toHaveBeenCalledWith({ alerts: 3, sent: 2 });
  });

  it("dedupe window starts at Berlin midnight of the run day", async () => {
    const alreadySent = vi.fn().mockResolvedValue(false);
    await runBudgetCheck(now, deps({ alreadySent }));
    expect((alreadySent.mock.calls[0][1] as Date).toISOString()).toBe("2026-10-28T23:00:00.000Z"); // CET midnight (UTC+1)
  });

  it("sends nothing when within budget but still logs the run (keep-alive trail)", async () => {
    const d = deps({ readMetrics: vi.fn().mockResolvedValue({ aiTodayMicroUsd: 0, aiMonthMicroUsd: 0, adbRemaining: null, orsRequestsToday: 0, errors24h: 0 }) });
    const r = await runBudgetCheck(now, d);
    expect(r.alerts).toEqual([]);
    expect(d.deliver).not.toHaveBeenCalled();
    expect(d.logRun).toHaveBeenCalledWith({ alerts: 0, sent: 0 });
  });

  it("a failing metrics read rejects (the route turns it into a 500)", async () => {
    await expect(runBudgetCheck(now, deps({ readMetrics: vi.fn().mockRejectedValue(new Error("db")) }))).rejects.toThrow("db");
  });
});
