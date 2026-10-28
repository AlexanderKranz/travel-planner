import { describe, expect, it } from "vitest";
import { ageDateFor, berlinToday } from "./age-date";

describe("ageDateFor", () => {
  it("uses the start date", () => {
    expect(ageDateFor({ kind: "date", startDate: "2027-03-07" }, "2026-10-28")).toBe("2027-03-07");
  });
  it("uses today without timing", () => {
    expect(ageDateFor({ kind: "none" }, "2026-10-28")).toBe("2026-10-28");
  });
  it("rolls December to the next occurrence and January to next year", () => {
    expect(ageDateFor({ kind: "months", months: [12] }, "2026-10-28")).toBe("2026-12-15");
    expect(ageDateFor({ kind: "months", months: [3, 12] }, "2026-10-28")).toBe("2026-12-15");
    expect(ageDateFor({ kind: "months", months: [3] }, "2026-10-28")).toBe("2027-03-15");
    expect(ageDateFor({ kind: "months", months: [10] }, "2026-10-28")).toBe("2026-10-15");
  });
  it("formats Berlin today", () => {
    expect(berlinToday(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01");
  });
});
