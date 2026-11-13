import { z } from "zod";
import { fetchJson } from "./http";

/**
 * Open-Meteo daily forecast for one day (spec 17.1 [P8]): weather code, max/min temperature, precipitation sum and
 * probability, with `timezone=auto` so the day is the tour centre's local day. Every value is nullable (spike 17.2:
 * the 16th day had no probability). Free, no key; up to 16 days ahead.
 */
export const FORECAST_DAYS = 16;

/** Today and the next 15 days (Open-Meteo's 16), compared as ISO dates; one day of slack for time zones. */
export function inForecastRange(date: string, now: Date = new Date()): boolean {
  const day = (offset: number) => new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  return date >= day(-1) && date <= day(FORECAST_DAYS - 1);
}

export type DailyForecast = {
  date: string;
  code: number | null;
  tMax: number | null;
  tMin: number | null;
  precipMm: number | null;
  precipProb: number | null;
};

const num = z.array(z.number().nullable()).length(1);
const ForecastResponse = z.object({
  daily: z.object({
    time: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).length(1),
    weather_code: num,
    temperature_2m_max: num,
    temperature_2m_min: num,
    precipitation_sum: num,
    precipitation_probability_max: num,
  }),
});

export function parseDailyForecast(body: unknown): DailyForecast {
  const d = ForecastResponse.parse(body).daily;
  return {
    date: d.time[0],
    code: d.weather_code[0],
    tMax: d.temperature_2m_max[0],
    tMin: d.temperature_2m_min[0],
    precipMm: d.precipitation_sum[0],
    precipProb: d.precipitation_probability_max[0],
  };
}

export function forecastUrl(lat: number, lon: number, date: string): string {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max` +
    `&timezone=auto&start_date=${date}&end_date=${date}`
  );
}

export async function fetchDailyForecast(lat: number, lon: number, date: string): Promise<{ forecast: DailyForecast; status: number; latencyMs: number }> {
  const r = await fetchJson(forecastUrl(lat, lon, date), { timeoutMs: 8000 });
  return { forecast: parseDailyForecast(r.body), status: r.status, latencyMs: r.latencyMs };
}
