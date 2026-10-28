import { describe, expect, it } from "vitest";
import type { Trip } from "@/lib/domain/trip";
import { addDays, flightDates, isoWeekday, lookupTtlSeconds, proxyDate, routesSampleDate, sampleSaturday } from "./lookups";

const TODAY = "2026-10-28";
const t = (timing: Trip["timing"], lengthDays = 5) => ({ timing, lengthDays });

describe("proxyDate", () => {
  it("keeps the weekday near the same date in the latest past year", () => {
    expect(proxyDate("2038-03-13", TODAY)).toBe("2026-03-14");
    expect(isoWeekday("2026-03-14")).toBe(isoWeekday("2038-03-13"));
    expect(proxyDate("2038-03-17", TODAY)).toBe("2026-03-18"); // golf trip return (5 days)
    expect(isoWeekday("2026-03-18")).toBe(isoWeekday("2038-03-17"));
  });
  it("uses the current year only when the shifted date is already past", () => {
    expect(proxyDate("2027-11-20", TODAY).slice(0, 4)).toBe("2025");
    expect(proxyDate("2027-09-04", TODAY).slice(0, 4)).toBe("2026");
  });
  it("handles 29 Feb", () => {
    const p = proxyDate("2028-02-29", TODAY);
    expect(p.slice(0, 7)).toBe("2026-02");
    expect(isoWeekday(p)).toBe(isoWeekday("2028-02-29"));
  });
  it("stays in the month when possible", () => {
    const p = proxyDate("2038-03-31", TODAY);
    expect(p.slice(0, 7)).toBe("2026-03");
  });
});

describe("routesSampleDate", () => {
  it("is the 15th, except after the last Sunday of March/October", () => {
    expect(routesSampleDate("2027-03-06")).toBe("2027-03-15");
    expect(routesSampleDate("2027-03-27")).toBe("2027-03-15");
    expect(routesSampleDate("2027-03-28")).toBe("2027-03-31"); // last Sunday: season change
    expect(routesSampleDate("2026-10-25")).toBe("2026-10-31");
  });
});

describe("flightDates", () => {
  it("kind none -> null", () => expect(flightDates(t({ kind: "none" }), TODAY)).toBeNull());
  it("trip dates in horizon", () => {
    expect(flightDates(t({ kind: "date", startDate: "2027-03-06" }), TODAY)).toEqual({
      basis: "trip_dates", outDate: "2027-03-06", backDate: "2027-03-10",
      mode: { out: "schedule", back: "schedule" }, checked: { out: "2027-03-06", back: "2027-03-10" },
    });
  });
  it("beyond the horizon uses proxies", () => {
    const d = flightDates(t({ kind: "date", startDate: "2038-03-13" }), TODAY)!;
    expect(d.mode).toEqual({ out: "proxy", back: "proxy" });
    expect(d.checked).toEqual({ out: "2026-03-14", back: "2026-03-18" });
    expect(d.backDate).toBe("2038-03-17");
  });
  it("horizon edge: 360 days schedule, 361 proxy", () => {
    expect(flightDates(t({ kind: "date", startDate: addDays(TODAY, 360) }, 1), TODAY)!.mode.out).toBe("schedule");
    expect(flightDates(t({ kind: "date", startDate: addDays(TODAY, 361) }, 1), TODAY)!.mode.out).toBe("proxy");
  });
  it("months mode: sample Saturday on/after the 8th of the first month", () => {
    const d = flightDates(t({ kind: "months", months: [3, 4] }, 7), TODAY)!;
    expect(d.basis).toBe("sample_week");
    expect(d.outDate).toBe("2027-03-13");
    expect(isoWeekday(d.outDate)).toBe(6);
    expect(d.backDate).toBe("2027-03-19");
  });
  it("months mode in the current month past the sample date rolls to next year", () => {
    expect(flightDates(t({ kind: "months", months: [10] }, 3), TODAY)!.outDate).toBe(sampleSaturday(2027, 10));
  });
});

describe("lookupTtlSeconds", () => {
  it("follows the spec", () => {
    const day = 86_400;
    expect(lookupTtlSeconds("routes_daily", "2026-03-15", TODAY)).toBe(90 * day);
    expect(lookupTtlSeconds("routes_daily", "2026-11-15", TODAY)).toBe(7 * day);
    expect(lookupTtlSeconds("routes_daily", "2027-03-15", TODAY)).toBe(14 * day);
    expect(lookupTtlSeconds("fids_departures", "2027-03-06", TODAY)).toBe(7 * day);
  });
});
