import { describe, expect, it } from "vitest";
import { berlinToday } from "./date";

describe("berlinToday", () => {
  it("rolls over at Berlin midnight (winter, UTC+1)", () => {
    expect(berlinToday(new Date("2026-12-31T22:59:00Z"))).toBe("2026-12-31");
    expect(berlinToday(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
  });
  it("handles summer time (UTC+2)", () => {
    expect(berlinToday(new Date("2026-07-01T21:59:00Z"))).toBe("2026-07-01");
    expect(berlinToday(new Date("2026-07-01T22:00:00Z"))).toBe("2026-07-02");
  });
  it("defaults to a YYYY-MM-DD string", () => {
    expect(berlinToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
