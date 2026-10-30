import { describe, expect, it } from "vitest";
import {
  formatHours,
  isValidTimeZone,
  timeDifferenceMinutes,
  tripTimeDifference,
  utcOffsets,
} from "./time-difference";

const city = (timezone: string | null) =>
  ({ kind: "city", name: "X", placeName: "X", geoId: 1, countryCode: null, admin1: null, lat: 0, lon: 0, timezone, radiusKm: 10 }) as const;
const date = (startDate: string, lengthDays = 7) => ({ timing: { kind: "date", startDate } as const, lengthDays });

describe("utcOffsets", () => {
  it("handles daylight saving", () => {
    expect(utcOffsets("Europe/Berlin", ["2026-01-15"])).toEqual(["+01:00"]);
    expect(utcOffsets("Europe/Berlin", ["2026-07-15"])).toEqual(["+02:00"]);
  });
  it("returns +00:00 for UTC", () => {
    expect(utcOffsets("UTC", ["2026-07-15"])).toEqual(["+00:00"]);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA zones and rejects garbage", () => {
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("timeDifferenceMinutes", () => {
  it("is 0 for the same zone and for Madrid", () => {
    expect(timeDifferenceMinutes("Europe/Berlin", "Europe/Berlin", ["2026-07-01"])).toEqual([0]);
    expect(timeDifferenceMinutes("Europe/Madrid", "Europe/Berlin", ["2026-07-01"])).toEqual([0]);
  });
  it("+60 for Athens", () => {
    expect(timeDifferenceMinutes("Europe/Athens", "Europe/Berlin", ["2026-07-01"])).toEqual([60]);
  });
  it("handles half-hour offsets", () => {
    expect(timeDifferenceMinutes("Asia/Kolkata", "Europe/Berlin", ["2026-01-15"])).toEqual([270]);
    expect(timeDifferenceMinutes("Asia/Kolkata", "Europe/Berlin", ["2026-07-15"])).toEqual([210]);
  });
  it("handles negative offsets", () => {
    expect(timeDifferenceMinutes("America/New_York", "Europe/Berlin", ["2026-07-15"])).toEqual([-360]);
  });
  it("reports both values when daylight saving differs during the trip", () => {
    // US switched on 2026-03-08, Europe on 2026-03-29: in between the gap is 5 h instead of 6 h.
    expect(timeDifferenceMinutes("America/New_York", "Europe/Berlin", ["2026-03-27", "2026-03-30"])).toEqual([-300, -360]);
  });
});

describe("tripTimeDifference", () => {
  it("defaults home to Europe/Berlin", () => {
    const r = tripTimeDifference({ destination: city("Asia/Tokyo"), ...date("2026-07-01") }, null, "2026-10-31");
    expect(r).toEqual({ minutes: [420], byMonth: false });
  });
  it("uses a custom home", () => {
    const r = tripTimeDifference({ destination: city("Europe/Berlin"), ...date("2026-07-01") }, "America/New_York", "2026-10-31");
    expect(r?.minutes).toEqual([360]);
  });
  it("is null without destination zone or for freetext", () => {
    expect(tripTimeDifference({ destination: city(null), ...date("2026-07-01") }, null, "2026-10-31")).toBeNull();
    expect(
      tripTimeDifference({ destination: { kind: "freetext", name: "X", countryCode: null }, ...date("2026-07-01") }, null, "2026-10-31"),
    ).toBeNull();
  });
  it("is null for an invalid zone instead of throwing", () => {
    expect(tripTimeDifference({ destination: city("Nope/Zone"), ...date("2026-07-01") }, null, "2026-10-31")).toBeNull();
    expect(tripTimeDifference({ destination: city("Asia/Tokyo"), ...date("2026-07-01") }, "Nope/Zone", "2026-10-31")).toBeNull();
  });
  it("uses candidate months and flags them", () => {
    const r = tripTimeDifference(
      { destination: city("America/New_York"), timing: { kind: "months", months: [3, 4] }, lengthDays: 7 },
      null,
      "2026-01-10",
    );
    expect(r).toEqual({ minutes: [-300, -360], byMonth: true });
  });
  it("falls back to today without timing", () => {
    const r = tripTimeDifference({ destination: city("Asia/Tokyo"), timing: { kind: "none" }, lengthDays: 5 }, null, "2026-01-10");
    expect(r?.minutes).toEqual([480]);
  });
});

describe("formatHours", () => {
  it("formats signs and half hours", () => {
    expect(formatHours(60)).toBe("+1");
    expect(formatHours(-360)).toBe("−6");
    expect(formatHours(270)).toBe("+4:30");
    expect(formatHours(-210)).toBe("−3:30");
    expect(formatHours(345)).toBe("+5:45");
    expect(formatHours(0)).toBe("0");
  });
});
