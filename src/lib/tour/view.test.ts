import { describe, expect, it } from "vitest";
import { TourInput, type TourResult } from "@/lib/domain/tour";
import { HOFBURG, NASCHMARKT, STEPHANSDOM } from "./fixtures.test-data";
import { tourView } from "./view";

const leg = (from: string, to: string, min: number | null) => ({
  from,
  to,
  mode: "foot" as const,
  route: "fastest" as const,
  min,
  km: min === null ? null : 1,
  poly: null,
  s: min === null ? ("failed" as const) : ("ok" as const),
});

const result = (mins: (number | null)[]): TourResult => ({
  v: 1,
  order: [STEPHANSDOM.key, HOFBURG.key, NASCHMARKT.key],
  legs: [leg(STEPHANSDOM.key, HOFBURG.key, mins[0]), leg(HOFBURG.key, NASCHMARKT.key, mins[1])],
  totalMin: mins.includes(null) ? null : 90 + (mins as number[]).reduce((a, b) => a + b, 0),
  fit: "none",
  sights: [],
  source: { ors: "2026-11-12T10:00:00Z" },
});

describe("tourView", () => {
  it("gives arrive/leave times with a start time and the minutes over the limit", () => {
    const input = TourInput.parse({ places: [STEPHANSDOM, HOFBURG, NASCHMARKT], startTime: "10:00", maxMin: 100 });
    const v = tourView(input, result([10, 15]));
    expect(v.stopTimes).toEqual([
      { arrive: "10:00", leave: "10:30" },
      { arrive: "10:40", leave: "11:10" },
      { arrive: "11:25", leave: "11:55" },
    ]);
    expect(v.byMin).toBe(15);
  });

  it("has no times without a start time or with a failed leg, and nothing without a result", () => {
    const input = TourInput.parse({ places: [STEPHANSDOM, HOFBURG, NASCHMARKT] });
    expect(tourView(input, result([10, 15]))).toEqual({ stopTimes: null, byMin: null });
    const timed = TourInput.parse({ places: [STEPHANSDOM, HOFBURG, NASCHMARKT], startTime: "10:00" });
    expect(tourView(timed, result([10, null])).stopTimes).toBeNull();
    expect(tourView(timed, null)).toEqual({ stopTimes: null, byMin: null });
  });
});
