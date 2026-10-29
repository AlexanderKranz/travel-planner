import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { adminPeriods } from "./periods";

describe("adminPeriods (Europe/Berlin)", () => {
  it("day and month start at Berlin midnight in winter time", () => {
    const p = adminPeriods(new Date("2026-12-15T10:00:00Z"));
    expect(p.dayStart.toISOString()).toBe("2026-12-14T23:00:00.000Z");
    expect(p.monthStart.toISOString()).toBe("2026-11-30T23:00:00.000Z");
  });
  it("handles DST: month starts in summer time, today in winter time", () => {
    const p = adminPeriods(new Date("2026-10-29T10:00:00Z")); // CET since 25 Oct
    expect(p.dayStart.toISOString()).toBe("2026-10-28T23:00:00.000Z");
    expect(p.monthStart.toISOString()).toBe("2026-09-30T22:00:00.000Z"); // CEST (UTC+2)
  });
  it("just after midnight Berlin belongs to the new day/month", () => {
    const p = adminPeriods(new Date("2026-10-31T23:30:00Z")); // 00:30 on 1 Nov (CET)
    expect(p.dayStart.toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(p.monthStart.toISOString()).toBe("2026-10-31T23:00:00.000Z");
  });
  it("last24h is exactly 24 h back", () => {
    const now = new Date("2026-10-29T10:00:00Z");
    expect(now.getTime() - adminPeriods(now).last24h.getTime()).toBe(86_400_000);
  });
});
