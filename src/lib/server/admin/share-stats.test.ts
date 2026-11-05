import { describe, expect, it } from "vitest";
import { ShareStatsRaw } from "./schema";
import { shapeDashboard } from "./shape";

const raw = {
  tripSharesRead: 3, tripSharesWrite: 2, purposeSharesRead: 1, purposeSharesWrite: 0,
  tripsShared: 4, recipients: 3, grantsThisMonth: 2, lookupsThisMonth: 7, lookupMissesThisMonth: 1,
};

describe("admin_share_stats reader", () => {
  it("accepts the counters of the SQL function and nothing with ids or emails", () => {
    expect(ShareStatsRaw.parse(raw)).toEqual(raw);
    expect(ShareStatsRaw.safeParse({ ...raw, recipients: -1 }).success).toBe(false);
    expect(ShareStatsRaw.safeParse({ ...raw, tripsShared: undefined }).success).toBe(false);
    expect(Object.keys(ShareStatsRaw.shape).sort()).toEqual(Object.keys(raw).sort());
  });
  it("shapeDashboard passes the counters through, or null when the reader failed", () => {
    const base = {
      users: { total: 1, admins: 1, active7: 1, active30: 1, newThisMonth: 0, demoLogins7: 0, demoLogins30: 0, demoAiCallsMonth: 0, demoAiMicroUsdMonth: 0 },
      usage: { trips: 0, tripsThisMonth: 0, plans: 0, versionsGenerate: 0, versionsPatch: 0, generatedThisMonth: 0, patchedThisMonth: 0, shareLinksActive: 0, perDay: [] },
      ai: { todayMicroUsd: 0, monthMicroUsd: 0, callsMonth: 0, failedMonth: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0, byTask: [], byModel: [] },
      api: { providers: [], aerodataboxQuotaRemaining: null, overpassVariants: [] },
      events: [],
    };
    const cfg = { aiDailyCapMicroUsd: 1, aiMonthlyAlertMicroUsd: 1, adbDailyUnits: 1, adbMinRemaining: 1, orsDailyCap: 1, geoapifyDailyCap: 1 };
    expect(shapeDashboard({ ...base, shares: raw }, cfg as never).shares).toEqual(raw);
    expect(shapeDashboard(base, cfg as never).shares).toBeNull();
  });
});
