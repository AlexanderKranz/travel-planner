import "server-only";
import { z } from "zod";
import type { Fact, FactsCtx, MonthlyClimate, WeatherFacts } from "@/lib/domain/facts";
import type { Trip } from "@/lib/domain/trip";
import { CLIMATE_PERIOD, aggregateClimate } from "@/lib/facts/climate";
import { selectedMonths } from "@/lib/facts/trip-timing";
import { fetchDailyHistory } from "@/lib/integrations/open-meteo-archive";
import { cacheKey, cached, type CachedResult } from "../api-cache";
import { geoDestination, toFact, unavailable } from "./common";

const monthSchema = z.object({
  month: z.number().int().min(1).max(12),
  tMaxC: z.number(),
  tMinC: z.number(),
  precipMm: z.number(),
  wetDays: z.number(),
  sunshineHours: z.number(),
});
const monthsSchema = z.array(monthSchema).length(12);

/** Weighted Open-Meteo units: ceil(4/10 x 3653/14) = 105 (spec 3.1). */
export const ARCHIVE_UNITS = 105;

/**
 * Monthly climate for a point, through the shared cache. The key depends only on the point rounded to 2 decimals
 * and the period, so a destination search and the trip made from it share one entry. `fetchAllowed` is the cache's
 * hook for "no network call" (the miss cap of the destination search).
 */
export function getClimateAt(
  point: { lat: number; lon: number },
  ctx: FactsCtx,
  opts: { fetchAllowed?: () => boolean } = {},
): Promise<CachedResult<MonthlyClimate[]>> {
  const lat = Number(point.lat.toFixed(2));
  const lon = Number(point.lon.toFixed(2));
  return cached({
    provider: "open_meteo_archive",
    endpoint: "archive",
    key: cacheKey("climate", 1, { lat, lon, from: CLIMATE_PERIOD.from, to: CLIMATE_PERIOD.to }),
    ttlSeconds: 365 * 86400,
    schema: monthsSchema,
    ctx,
    fetchAllowed: opts.fetchAllowed,
    fetcher: async () => {
      const r = await fetchDailyHistory(lat, lon, CLIMATE_PERIOD);
      return { data: aggregateClimate(r.series), status: r.status, latencyMs: r.latencyMs, units: ARCHIVE_UNITS };
    },
  });
}

export async function getWeatherFacts(trip: Trip, ctx: FactsCtx): Promise<Fact<WeatherFacts>> {
  try {
    const dest = geoDestination(trip);
    if (!dest) return unavailable("no_location");
    const res = await getClimateAt(dest, ctx);
    return toFact(
      res,
      "open_meteo",
      (months) => ({ months, selectedMonths: selectedMonths(trip), period: { ...CLIMATE_PERIOD } }),
      "https://open-meteo.com/",
    );
  } catch {
    return unavailable("provider_error", "open_meteo");
  }
}
