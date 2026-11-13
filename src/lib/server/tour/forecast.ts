"use server";

import { z } from "zod";
import { inForecastRange } from "@/lib/facts/forecast-range";
import { fetchDailyForecast, type DailyForecast } from "@/lib/integrations/open-meteo-forecast";
import { tourCentre, tourPointsOf } from "@/lib/tour/points";
import { cacheKey, cached } from "../api-cache";
import { rateLimit } from "../rate-limit";
import { getUserSession } from "../session";
import { rowToTour, TOUR_COLUMNS, type TourRow } from "./mapping";

/**
 * Daily weather forecast for a saved tour's date at its centre (spec 17.1 [P8]), only when the date is within the
 * next 16 days. Open-Meteo `/v1/forecast`, cached 3 h per rounded centre (2 dp) and date. Any reader of the tour.
 * Returns null when there is nothing to show (no date, no centre, out of range, provider down): never a guess.
 */
export type TourForecast = DailyForecast & { fetchedAt: string };

const Id = z.string().uuid();
const TTL_SECONDS = 3 * 3600;

export async function getTourForecast(id: string): Promise<TourForecast | null> {
  try {
    const session = await getUserSession();
    if (!session || !Id.safeParse(id).success) return null;
    if (!rateLimit(`tour-forecast:${session.userId}`, 30, 60_000).ok) return null;
    const { data: row } = await session.supabase.from("city_tours").select(TOUR_COLUMNS).eq("id", id).maybeSingle<TourRow>();
    const tour = row ? rowToTour(row, session.userId) : null;
    const date = tour?.input.date;
    if (!tour || !date || !inForecastRange(date)) return null;
    const c = tourCentre(tour.input, tourPointsOf(tour.input).points);
    if (!c) return null;
    const lat = Math.round(c.lat * 100) / 100;
    const lon = Math.round(c.lon * 100) / 100;
    const res = await cached<DailyForecast>({
      provider: "open_meteo_forecast",
      endpoint: "forecast",
      key: cacheKey("forecast", 1, { lat, lon, date }),
      ttlSeconds: TTL_SECONDS,
      schema: z.object({
        date: z.string(),
        code: z.number().nullable(),
        tMax: z.number().nullable(),
        tMin: z.number().nullable(),
        precipMm: z.number().nullable(),
        precipProb: z.number().nullable(),
      }),
      ctx: { userId: session.userId },
      fetcher: async () => {
        const r = await fetchDailyForecast(lat, lon, date);
        return { data: r.forecast, status: r.status, latencyMs: r.latencyMs };
      },
    });
    if (!res.ok || res.data.date !== date) return null;
    return { ...res.data, fetchedAt: res.fetchedAt };
  } catch {
    return null;
  }
}
