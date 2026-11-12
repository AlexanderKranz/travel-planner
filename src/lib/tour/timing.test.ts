import { describe, expect, it } from "vitest";
import {
  effectiveMaxMin,
  hhmmToMin,
  minToHhmm,
  stopTimes,
  sunsetWarning,
  tourFit,
  tourTotalMin,
} from "./timing";

const WIEN = { lat: 48.2082, lon: 16.3738 };

describe("timing", () => {
  it("converts times", () => {
    expect(hhmmToMin("09:45")).toBe(585);
    expect(minToHhmm(585)).toBe("09:45");
    expect(minToHhmm(1440 + 30)).toBe("00:30");
  });

  it("effective max is the smaller of maxMin and endBy − startTime", () => {
    expect(effectiveMaxMin({})).toBeUndefined();
    expect(effectiveMaxMin({ maxMin: 240 })).toBe(240);
    expect(effectiveMaxMin({ startTime: "10:00", endBy: "13:00" })).toBe(180);
    expect(effectiveMaxMin({ maxMin: 120, startTime: "10:00", endBy: "13:00" })).toBe(120);
    expect(effectiveMaxMin({ maxMin: 240, startTime: "10:00", endBy: "13:00" })).toBe(180);
    expect(effectiveMaxMin({ maxMin: 240, endBy: "13:00" })).toBe(240);
  });

  it("totals legs and dwell; a failed leg gives no total", () => {
    expect(tourTotalMin([10, 15], [0, 30, 45])).toBe(100);
    expect(tourTotalMin([10, null], [0, 30, 45])).toBeNull();
  });

  it("gives arrive and leave times per stop", () => {
    expect(stopTimes("10:00", [12, 8], [0, 30, 45])).toEqual([
      { arrive: "10:00", leave: "10:00" },
      { arrive: "10:12", leave: "10:42" },
      { arrive: "10:50", leave: "11:35" },
    ]);
    expect(stopTimes("10:00", [null], [0, 30])).toBeNull();
  });

  it("judges the fit", () => {
    expect(tourFit(200, undefined, undefined)).toEqual({ fit: "none" });
    expect(tourFit(null, 60, 120)).toEqual({ fit: "none" });
    expect(tourFit(100, 60, 120)).toEqual({ fit: "ok" });
    expect(tourFit(120, 120, 120)).toEqual({ fit: "ok" });
    expect(tourFit(138, 60, 120)).toEqual({ fit: "over", byMin: 18 });
    expect(tourFit(20, 60, undefined)).toEqual({ fit: "under", byMin: 40 });
  });

  it("warns after sunset in Wien in December (suncalc, local time)", () => {
    const base = { date: "2026-12-15", centre: WIEN, timeZone: "Europe/Vienna" };
    const s = sunsetWarning({ ...base, startTime: "14:00", totalMin: 150 });
    expect(s).toMatch(/^(15:5\d|16:0\d)$/);
    expect(sunsetWarning({ ...base, startTime: "10:00", totalMin: 150 })).toBeUndefined();
    // Summer: the same tour is fine.
    expect(sunsetWarning({ ...base, date: "2026-06-21", startTime: "14:00", totalMin: 150 })).toBeUndefined();
  });

  it("gives no sunset warning without date, start time, total or zone", () => {
    const a = { date: "2026-12-15", startTime: "14:00", totalMin: 300, centre: WIEN, timeZone: "Europe/Vienna" };
    expect(sunsetWarning(a)).toBeDefined();
    expect(sunsetWarning({ ...a, date: undefined })).toBeUndefined();
    expect(sunsetWarning({ ...a, startTime: undefined })).toBeUndefined();
    expect(sunsetWarning({ ...a, totalMin: null })).toBeUndefined();
    expect(sunsetWarning({ ...a, timeZone: null })).toBeUndefined();
  });
});
