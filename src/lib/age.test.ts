import { describe, expect, it } from "vitest";
import { ageOn } from "./age";

describe("ageOn", () => {
  it("counts full years", () => {
    expect(ageOn("1980-06-15", "2026-12-19")).toBe(46);
  });

  it("does not count the year before the birthday", () => {
    expect(ageOn("1980-12-20", "2026-12-19")).toBe(45);
  });

  it("counts the birthday itself", () => {
    expect(ageOn("2025-03-13", "2027-03-13")).toBe(2);
  });

  it("handles toddlers under one year", () => {
    expect(ageOn("2026-05-01", "2026-12-19")).toBe(0);
  });

  it("rejects dates before birth", () => {
    expect(() => ageOn("2026-05-01", "2026-04-30")).toThrow(RangeError);
  });

  it("rejects malformed input", () => {
    expect(() => ageOn("19.12.2026", "2026-12-19")).toThrow(TypeError);
  });
});
