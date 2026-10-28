/**
 * Open-Meteo Historical Weather API (ERA5 / ERA5-Land reanalysis, keyless, CC BY 4.0).
 * Docs: https://open-meteo.com/en/docs/historical-weather-api (checked 2026-10-28)
 * Verified live 2026-10-28: 10 years x 4 daily variables = 3653 days, ~135 KB, ~0.5 s, no missing values
 * for Malaga. The response snaps to the reanalysis grid (36.72,-4.42 came back as 36.731,-4.370).
 * Only the 12-row aggregate is cached (see src/lib/facts/climate.ts).
 */
import "server-only";
import { z } from "zod";
import { fetchJson } from "./http";

export type DailySeries = {
  time: string[];
  tMax: (number | null)[];
  tMin: (number | null)[];
  precip: (number | null)[];
  sunshineS: (number | null)[];
};

const num = z.number().nullable();
const archiveResponse = z.object({
  daily: z.object({
    time: z.array(z.string()),
    temperature_2m_max: z.array(num),
    temperature_2m_min: z.array(num),
    precipitation_sum: z.array(num),
    sunshine_duration: z.array(num),
  }),
});

export function parseArchive(body: unknown): DailySeries {
  const d = archiveResponse.parse(body).daily;
  const n = d.time.length;
  if ([d.temperature_2m_max, d.temperature_2m_min, d.precipitation_sum, d.sunshine_duration].some((a) => a.length !== n)) {
    throw new z.ZodError([{ code: "custom", path: ["daily"], message: "array length mismatch", input: d }]);
  }
  return { time: d.time, tMax: d.temperature_2m_max, tMin: d.temperature_2m_min, precip: d.precipitation_sum, sunshineS: d.sunshine_duration };
}

export async function fetchDailyHistory(
  lat: number,
  lon: number,
  period: { from: number; to: number },
): Promise<{ series: DailySeries; status: number; latencyMs: number }> {
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}` +
    `&start_date=${period.from}-01-01&end_date=${period.to}-12-31` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,sunshine_duration&timezone=auto`;
  const r = await fetchJson(url, { timeoutMs: 20000 });
  return { series: parseArchive(r.body), status: r.status, latencyMs: r.latencyMs };
}
