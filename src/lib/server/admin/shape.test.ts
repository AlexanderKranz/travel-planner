import { describe, expect, it } from "vitest";
import type { BudgetConfig } from "./config";
import { cacheHitShare, meter, microToUsd, ratePct, shapeDashboard } from "./shape";

const cfg: BudgetConfig = { aiDailyCapMicroUsd: 5_000_000, aiMonthlyAlertMicroUsd: 10_000_000, adbDailyUnits: 40, adbMinRemaining: 40, orsDailyCap: 400, geoapifyDailyCap: 400, errors24hThreshold: 20 };

describe("meter", () => {
  it("levels: ok below 80 %, warn from 80 %, over at the cap", () => {
    expect(meter(79, 100).level).toBe("ok");
    expect(meter(80, 100).level).toBe("warn");
    expect(meter(100, 100)).toMatchObject({ level: "over", pct: 100 });
    expect(meter(120, 100).pct).toBe(120);
  });
  it("a zero cap never alerts", () => {
    expect(meter(5, 0)).toMatchObject({ pct: 0, level: "ok" });
  });
});

describe("helpers", () => {
  it("ratePct and cacheHitShare return null without data", () => {
    expect(ratePct(1, 0)).toBeNull();
    expect(ratePct(1, 8)).toBe(12.5);
    expect(cacheHitShare(0, 0, 0)).toBeNull();
    expect(cacheHitShare(100, 300, 100)).toBe(60);
  });
  it("microUsd to dollars at cent precision", () => {
    expect(microToUsd(1_234_567)).toBe(1.23);
    expect(microToUsd(0)).toBe(0);
  });
});

const raw = {
  users: { total: 3, admins: 1, active7: 2, active30: 3, newThisMonth: 1, demoLogins7: 4, demoLogins30: 9, demoAiCallsMonth: 2, demoAiMicroUsdMonth: 5000 },
  usage: {
    trips: 5, tripsThisMonth: 2, plans: 3, versionsGenerate: 4, versionsPatch: 2, generatedThisMonth: 2, patchedThisMonth: 1, shareLinksActive: 1,
    perDay: [
      { day: "2026-10-28", generated: 2, patched: 2 },
      { day: "2026-10-29", generated: 1, patched: 0 },
    ],
  },
  ai: {
    todayMicroUsd: 4_100_000, monthMicroUsd: 2_000_000, callsMonth: 9, failedMonth: 1, inputTokens: 100, cacheReadTokens: 300, cacheCreationTokens: 100, outputTokens: 50,
    byTask: [{ key: "plan_generate", calls: 3, microUsd: 1_500_000 }],
    byModel: [{ key: "claude-sonnet-5-5", calls: 3, microUsd: 1_500_000 }],
  },
  api: {
    providers: [
      { provider: "aerodatabox", callsToday: 3, callsMonth: 10, networkToday: 3, networkMonth: 8, errorsMonth: 2, p50Ms: 400, p95Ms: 900, unitsToday: 36, unitsMonth: 90 },
      { provider: "openrouteservice", callsToday: 5, callsMonth: 6, networkToday: 4, networkMonth: 5, errorsMonth: 0, p50Ms: null, p95Ms: null, unitsToday: 0, unitsMonth: 0 },
    ],
    aerodataboxQuotaRemaining: 70,
    overpassVariants: [{ variant: "overpass-api.de", calls: 4, errors: 1 }],
  },
  events: [],
};

describe("shapeDashboard", () => {
  const d = shapeDashboard(raw, cfg);
  it("scales the per-day bars to the busiest day", () => {
    expect(d.usage.perDay.map((x) => x.widthPct)).toEqual([100, 25]);
  });
  it("lists all known AI tasks, unused ones with zero", () => {
    expect(d.ai.byTask.map((t) => t.key)).toEqual(["purpose_tags", "group_parse", "destination_ideas", "plan_generate", "plan_patch"]);
    expect(d.ai.byTask[3].widthPct).toBe(100);
    expect(d.ai.byTask[0]).toMatchObject({ calls: 0, microUsd: 0 });
  });
  it("compares AI spend with the budgets and computes the cache share", () => {
    expect(d.ai.today).toMatchObject({ pct: 82, level: "warn" });
    expect(d.ai.month).toMatchObject({ pct: 20, level: "ok" });
    expect(d.ai.cacheHitSharePct).toBe(60);
  });
  it("derives error rate per provider from real requests", () => {
    expect(d.providers[0].errorRatePct).toBe(25);
    expect(d.providers[0].hitSharePct).toBe(20);
  });
  it("AeroDataBox: units vs daily cap, warn below 2x the margin", () => {
    expect(d.adb.unitsToday).toMatchObject({ pct: 90, level: "warn" });
    expect(d.adb.level).toBe("warn");
    expect(shapeDashboard({ ...raw, api: { ...raw.api, aerodataboxQuotaRemaining: 30 } }, cfg).adb.level).toBe("over");
    expect(shapeDashboard({ ...raw, api: { ...raw.api, aerodataboxQuotaRemaining: null } }, cfg).adb.level).toBe("ok");
  });
  it("ORS: network requests today vs the cap", () => {
    expect(d.ors.requestsToday).toMatchObject({ used: 4, cap: 400, level: "ok" });
  });
  it("carries no user identifiers", () => {
    expect(JSON.stringify(d)).not.toMatch(/user_id|userId|email/i);
  });
});
