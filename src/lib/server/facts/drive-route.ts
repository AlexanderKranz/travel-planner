import "server-only";
import { z } from "zod";
import type { FactsCtx } from "@/lib/domain/facts";
import { fetchDriveRoute, type DriveRoute, type LonLat } from "@/lib/integrations/openrouteservice";
import { cacheKey, cached, type CachedResult } from "../api-cache";
import { assertOrsQuota } from "./ors-quota";

/** 90 days, like plan drive times: roads change slowly. */
export const DRIVE_ROUTE_TTL_SECONDS = 90 * 86400;

const Payload = z.discriminatedUnion("road", [
  z.object({ road: z.literal(true), min: z.number().int().min(1), km: z.number().min(0) }),
  z.object({ road: z.literal(false) }),
]);

/**
 * Key per place pair (spec find-destinations-drive section 5): start at 3 decimals (~100 m) and the GeoNames id of
 * the destination. It holds two public places and no owner, so every later search from the same town hits it, also
 * across users. A matrix key over a whole idea list would almost never hit again.
 */
export function driveRouteKey(origin: LonLat, geoId: number): string {
  return cacheKey("route", 1, { lat: Number(origin.lat.toFixed(3)), lon: Number(origin.lon.toFixed(3)), geoId });
}

/**
 * One cached ferry-free route from `origin` to a place. "No road" (an island, a country behind a sea) is a cached
 * result like any other, so it is asked once. A failure (timeout, 5xx, quota, key missing) is `ok: false`, never a
 * negative: the caller must not treat an outage as "unreachable". Never throws.
 */
export async function getDriveRoute(
  origin: LonLat,
  place: { geoId: number; lat: number; lon: number },
  ctx: FactsCtx,
  opts: { fetchAllowed?: () => boolean } = {},
): Promise<CachedResult<DriveRoute>> {
  if (!process.env.OPENROUTESERVICE_API_KEY?.trim()) return { ok: false, error: "provider_error" };
  try {
    return await cached<DriveRoute>({
      provider: "openrouteservice",
      endpoint: "route",
      key: driveRouteKey(origin, place.geoId),
      ttlSeconds: DRIVE_ROUTE_TTL_SECONDS,
      schema: Payload,
      ctx,
      fetchAllowed: opts.fetchAllowed,
      fetcher: async () => {
        await assertOrsQuota();
        const r = await fetchDriveRoute(origin, place);
        return { data: r.route, status: r.status, latencyMs: r.latencyMs };
      },
    });
  } catch {
    return { ok: false, error: "provider_error" };
  }
}
