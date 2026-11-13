import { describe, expect, it } from "vitest";
import { forecastUrl, inForecastRange, parseDailyForecast } from "./open-meteo-forecast";

const body = (prob: number | null) => ({
  daily: {
    time: ["2026-11-20"],
    weather_code: [61],
    temperature_2m_max: [8.1],
    temperature_2m_min: [4.2],
    precipitation_sum: [9.2],
    precipitation_probability_max: [prob],
  },
});

describe("daily forecast", () => {
  it("asks one local day with timezone=auto (spec 17.1 [P8])", () => {
    const u = new URL(forecastUrl(48.2081, 16.3713, "2026-11-20"));
    expect(u.searchParams.get("timezone")).toBe("auto");
    expect(u.searchParams.get("start_date")).toBe("2026-11-20");
    expect(u.searchParams.get("end_date")).toBe("2026-11-20");
    expect(u.searchParams.get("latitude")).toBe("48.21");
    expect(u.searchParams.get("daily")).toBe("weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max");
  });

  it("parses one day; every value may be null (spike: day 16 without probability)", () => {
    expect(parseDailyForecast(body(100))).toEqual({ date: "2026-11-20", code: 61, tMax: 8.1, tMin: 4.2, precipMm: 9.2, precipProb: 100 });
    expect(parseDailyForecast(body(null)).precipProb).toBeNull();
    expect(() => parseDailyForecast({ daily: { time: [] } })).toThrow();
  });

  it("range: today (with a day of slack) to 15 days ahead", () => {
    const now = new Date("2026-11-13T12:00:00Z");
    expect(inForecastRange("2026-11-12", now)).toBe(true);
    expect(inForecastRange("2026-11-11", now)).toBe(false);
    expect(inForecastRange("2026-11-28", now)).toBe(true);
    expect(inForecastRange("2026-11-29", now)).toBe(false);
  });
});
