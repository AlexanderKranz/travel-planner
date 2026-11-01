import { describe, expect, it } from "vitest";
import type { MonthlyClimate } from "@/lib/domain/facts";
import { climateMean, passesAllClimate, passesClimate } from "./climate-rules";

const m = (tMaxC: number, tMinC: number, wetDays: number) => ({ tMaxC, tMinC, wetDays });

describe("climate rules at their thresholds (inclusive bounds)", () => {
  it("golf: tMax >= 12 and wetDays <= 12", () => {
    expect(passesClimate("golf", m(12, 5, 12))).toBe(true);
    expect(passesClimate("golf", m(11.9, 5, 12))).toBe(false);
    expect(passesClimate("golf", m(12, 5, 12.1))).toBe(false);
  });
  it("beach: tMax >= 23", () => {
    expect(passesClimate("beach", m(23, 10, 0))).toBe(true);
    expect(passesClimate("beach", m(22.9, 10, 0))).toBe(false);
  });
  it("hiking: tMax from 5 to 32", () => {
    expect(passesClimate("hiking", m(5, 0, 5))).toBe(true);
    expect(passesClimate("hiking", m(32, 20, 5))).toBe(true);
    expect(passesClimate("hiking", m(4.9, 0, 5))).toBe(false);
    expect(passesClimate("hiking", m(32.1, 20, 5))).toBe(false);
  });
  it("cycling: tMax >= 10 and wetDays <= 14", () => {
    expect(passesClimate("cycling", m(10, 0, 14))).toBe(true);
    expect(passesClimate("cycling", m(9.9, 0, 14))).toBe(false);
    expect(passesClimate("cycling", m(10, 0, 14.1))).toBe(false);
  });
  it("skiing: tMin <= 0", () => {
    expect(passesClimate("skiing", m(5, 0, 5))).toBe(true);
    expect(passesClimate("skiing", m(5, 0.1, 5))).toBe(false);
  });
  it("every other interest always passes: the climate is shown, never filtered", () => {
    for (const k of ["museums", "city_sightseeing", "wellness", "christmas_markets", "cruise", "food_wine", "family_activities"] as const) {
      expect(passesClimate(k, m(-30, -40, 30)), k).toBe(true);
    }
  });
  it("all searched interests must pass; none passes trivially (E4)", () => {
    expect(passesAllClimate(["golf", "beach"], m(20, 10, 5))).toBe(false);
    expect(passesAllClimate(["golf", "museums"], m(20, 10, 5))).toBe(true);
    expect(passesAllClimate([], m(-10, -20, 30))).toBe(true);
  });
});

describe("climateMean", () => {
  const months: MonthlyClimate[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    tMaxC: 10 + i,
    tMinC: i,
    precipMm: 50,
    wetDays: 2 * i,
    sunshineHours: 5,
  }));
  it("is the mean of the selected months only", () => {
    expect(climateMean(months, [1, 3])).toEqual({ tMaxC: 11, tMinC: 1, wetDays: 2 });
  });
  it("null when none of the months is in the data", () => {
    expect(climateMean(months, [])).toBeNull();
    expect(climateMean([], [3])).toBeNull();
  });
});
