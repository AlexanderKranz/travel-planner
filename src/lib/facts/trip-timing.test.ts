import { describe, expect, it } from "vitest";
import { ageReferenceDate, daylightDates, nextOccurrence15th, referenceDates, selectedMonths } from "./trip-timing";

const date = (startDate: string, lengthDays: number) => ({ timing: { kind: "date", startDate } as const, lengthDays });
const months = (m: number[]) => ({ timing: { kind: "months", months: m } as const, lengthDays: 7 });
const none = { timing: { kind: "none" } as const, lengthDays: 7 };

describe("trip timing", () => {
  it("next occurrence rolls over to next year only for past months", () => {
    expect(nextOccurrence15th(12, "2026-10-28")).toBe("2026-12-15");
    expect(nextOccurrence15th(10, "2026-10-28")).toBe("2026-10-15"); // current month counts
    expect(nextOccurrence15th(3, "2026-10-28")).toBe("2027-03-15");
    expect(nextOccurrence15th(12, "2026-12-31")).toBe("2026-12-15");
    expect(nextOccurrence15th(1, "2026-12-31")).toBe("2027-01-15");
  });

  it("date mode spans two months", () => {
    const t = date("2026-12-29", 5);
    expect(referenceDates(t, "2026-10-28")).toEqual(["2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(selectedMonths(t)).toEqual([1, 12]);
    expect(ageReferenceDate(t, "2026-10-28")).toBe("2026-12-29");
  });

  it("months mode uses the 15th of the next occurrences, sorted", () => {
    const t = months([3, 12]);
    expect(referenceDates(t, "2026-10-28")).toEqual(["2026-12-15", "2027-03-15"]);
    expect(selectedMonths(t)).toEqual([3, 12]);
    expect(ageReferenceDate(t, "2026-10-28")).toBe("2026-12-15");
  });

  it("none mode: no reference dates, overview of 12 months", () => {
    expect(referenceDates(none, "2026-10-28")).toEqual([]);
    expect(selectedMonths(none)).toEqual([]);
    expect(ageReferenceDate(none, "2026-10-28")).toBeNull();
    const d = daylightDates(none, "2026-10-28");
    expect(d.basis).toBe("mid_month");
    expect(d.dates).toHaveLength(12);
    expect(d.dates[0]).toBe("2026-01-15");
  });

  it("daylight dates: all days up to 14, else first/every 7th/last", () => {
    expect(daylightDates(date("2026-12-01", 14), "2026-10-28").dates).toHaveLength(14);
    const long = daylightDates(date("2026-12-01", 20), "2026-10-28");
    expect(long.basis).toBe("trip_dates");
    expect(long.dates).toEqual(["2026-12-01", "2026-12-08", "2026-12-15", "2026-12-20"]);
  });
});
