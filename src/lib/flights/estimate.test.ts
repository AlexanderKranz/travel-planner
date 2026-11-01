import { describe, expect, it } from "vitest";
import raw from "@/data/airports.json";
import { haversineKm } from "@/lib/facts/places";
import { approxBlockMin } from "./build";
import { blockMinFromKm, flightRadiusKm, LIMIT_TOLERANCE_MIN, MAX_ORIGINS, roundedFlightMin } from "./estimate";

type Tuple = [string, string, string, string, number, number];
const at = new Map((raw as unknown as { airports: Tuple[] }).airports.map((a) => [a[0], { lat: a[4], lon: a[5] }]));
const km = (a: string, b: string) => haversineKm(at.get(a)!, at.get(b)!);

describe("flightRadiusKm (spec find-destinations section 3)", () => {
  it("pins the three documented radii", () => {
    expect(flightRadiusKm(2)).toBe(1330);
    expect(flightRadiusKm(2.5)).toBe(1729);
    expect(flightRadiusKm(3)).toBe(2128);
  });
  it("without the tolerance 2 h would be 1,197 km (the strict alternative)", () => {
    expect(Math.round((120 - 30) * 13.3)).toBe(1197);
    expect(LIMIT_TOLERANCE_MIN).toBe(10);
  });
  it("the estimate at the radius is exactly limit + tolerance", () => {
    for (const h of [1, 2, 2.5, 3, 5]) expect(blockMinFromKm(flightRadiusKm(h))).toBeCloseTo(60 * h + LIMIT_TOLERANCE_MIN, 0);
  });
});

describe("estimates for the spec routes", () => {
  it("FRA-PMI: about 1,251 km, 124 min, ca. 2 h, inside the 2 h radius", () => {
    expect(km("FRA", "PMI")).toBeGreaterThan(1245);
    expect(km("FRA", "PMI")).toBeLessThan(1257);
    expect(Math.round(blockMinFromKm(km("FRA", "PMI")))).toBe(124);
    expect(roundedFlightMin(blockMinFromKm(km("FRA", "PMI")))).toBe(120);
    expect(km("FRA", "PMI")).toBeLessThanOrEqual(flightRadiusKm(2));
  });
  it("FRA-AGP: about 1,816 km, 167 min, ca. 3 h, outside 2 h and 2.5 h, inside 3 h", () => {
    expect(Math.round(km("FRA", "AGP"))).toBeGreaterThan(1810);
    expect(Math.round(km("FRA", "AGP"))).toBeLessThan(1822);
    expect(Math.round(blockMinFromKm(km("FRA", "AGP")))).toBe(167);
    expect(roundedFlightMin(blockMinFromKm(km("FRA", "AGP")))).toBe(180);
    expect(km("FRA", "AGP")).toBeGreaterThan(flightRadiusKm(2));
    expect(km("FRA", "AGP")).toBeGreaterThan(flightRadiusKm(2.5));
    expect(km("FRA", "AGP")).toBeLessThanOrEqual(flightRadiusKm(3));
  });
  it("FRA-FAO: about 1,958 km, 177 min, ca. 3 h, outside 2.5 h, inside 3 h", () => {
    expect(Math.round(blockMinFromKm(km("FRA", "FAO")))).toBe(177);
    expect(roundedFlightMin(blockMinFromKm(km("FRA", "FAO")))).toBe(180);
    expect(km("FRA", "FAO")).toBeGreaterThan(flightRadiusKm(2.5));
    expect(km("FRA", "FAO")).toBeLessThanOrEqual(flightRadiusKm(3));
  });
});

describe("roundedFlightMin", () => {
  it("rounds to the nearest half hour", () => {
    expect(roundedFlightMin(74)).toBe(60);
    expect(roundedFlightMin(75)).toBe(90);
    expect(roundedFlightMin(124)).toBe(120);
  });
  it("never shows above the limit: the largest allowed estimate rounds down to the limit", () => {
    for (const h of [1, 1.5, 2, 2.5, 3, 4, 5.5]) {
      expect(roundedFlightMin(60 * h + LIMIT_TOLERANCE_MIN)).toBeLessThanOrEqual(60 * h);
    }
  });
});

describe("one formula", () => {
  it("approxBlockMin is the estimate rounded to 5 minutes", () => {
    expect(approxBlockMin("FRA", "AGP")).toBe(165);
    expect(approxBlockMin("FRA", "AGP")).toBe(Math.round(blockMinFromKm(km("FRA", "AGP")) / 5) * 5);
  });
  it("at most 2 origins, shared with the flight check", () => {
    expect(MAX_ORIGINS).toBe(2);
  });
});
