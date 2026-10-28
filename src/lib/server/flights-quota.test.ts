import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = { sum: [] as { units: number | null }[], last: [] as { quota_remaining: number }[], since: "" };
vi.mock("./supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: () => {
      let isSum = true;
      const chain: Record<string, unknown> = {
        select: (cols: string) => ((isSum = cols === "units"), chain),
        eq: () => chain,
        gte: (_c: string, v: string) => ((state.since = v), chain),
        not: () => chain,
        order: () => chain,
        limit: () => chain,
        then: (res: (v: unknown) => void) => res({ data: isSum ? state.sum : state.last, error: null }),
      };
      return chain;
    },
  }),
}));

import { QuotaGuardError, assertUnits, berlinMidnightUtc, checkUnits, getQuotaState } from "./flights-quota";

beforeEach(() => {
  state.sum = [];
  state.last = [];
  delete process.env.AERODATABOX_DAILY_UNITS;
  delete process.env.AERODATABOX_MIN_REMAINING;
});

describe("berlinMidnightUtc", () => {
  it("winter (UTC+1) and summer (UTC+2)", () => {
    expect(berlinMidnightUtc(new Date("2026-01-15T10:00:00Z")).toISOString()).toBe("2026-01-14T23:00:00.000Z");
    expect(berlinMidnightUtc(new Date("2026-07-15T10:00:00Z")).toISOString()).toBe("2026-07-14T22:00:00.000Z");
  });
  it("uses the Berlin day when UTC is still the day before", () => {
    expect(berlinMidnightUtc(new Date("2026-07-15T22:30:00Z")).toISOString()).toBe("2026-07-15T22:00:00.000Z");
  });
  it("DST change day starts at +1", () => {
    expect(berlinMidnightUtc(new Date("2026-03-29T12:00:00Z")).toISOString()).toBe("2026-03-28T23:00:00.000Z");
  });
});

describe("checkUnits", () => {
  const s = { usedToday: 30, dailyCap: 40, remaining: 200 as number | null, minRemaining: 40 };
  it("daily cap", () => {
    expect(checkUnits(s, 10)).toBeNull();
    expect(checkUnits(s, 11)).toMatch(/daily/);
  });
  it("monthly margin", () => {
    expect(checkUnits({ ...s, usedToday: 0, remaining: 45 }, 6)).toMatch(/monthly/);
    expect(checkUnits({ ...s, usedToday: 0, remaining: 46 }, 6)).toBeNull();
  });
  it("unknown remaining does not block", () => expect(checkUnits({ ...s, usedToday: 0, remaining: null }, 6)).toBeNull());
});

describe("getQuotaState / assertUnits", () => {
  it("sums units, null units count as 0, remaining from newest row, env overrides", async () => {
    state.sum = [{ units: 6 }, { units: null }, { units: 2 }];
    state.last = [{ quota_remaining: 300 }];
    process.env.AERODATABOX_DAILY_UNITS = "50";
    expect(await getQuotaState()).toEqual({ usedToday: 8, dailyCap: 50, remaining: 300, minRemaining: 40 });
  });
  it("remaining null when never seen", async () => {
    expect((await getQuotaState()).remaining).toBeNull();
  });
  it("throws QuotaGuardError over the cap", async () => {
    state.sum = [{ units: 38 }];
    await expect(assertUnits(6)).rejects.toBeInstanceOf(QuotaGuardError);
    await expect(assertUnits(2)).resolves.toBeUndefined();
  });
});
