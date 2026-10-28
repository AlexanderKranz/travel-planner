import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { FactsCtx } from "@/lib/domain/facts";
import { ORS_MAX_DESTINATIONS, fetchDriveMatrix, type LonLat } from "@/lib/integrations/openrouteservice";
import { cacheKey, cached } from "../api-cache";
import { berlinMidnightUtc, QuotaGuardError } from "../flights-quota";
import { createSupabaseAdminClient } from "../supabase/admin";

/** Drive time and road distance from the destination point, per OSM key. Only reachable places are present. */
export type DriveTimes = { byKey: Record<string, { min: number; km: number }>; fetchedAt: string };

export const DRIVE_TTL_SECONDS = 90 * 86400;
/** Default daily request cap (free Standard key allows ~500 matrix requests/day). */
export const ORS_DAILY_REQUESTS_DEFAULT = 400;

const Payload = z.record(z.string(), z.object({ min: z.number().int().min(0), km: z.number().min(0) }));

export function orsDailyCap(env: Record<string, string | undefined> = process.env): number {
  const n = Number.parseInt(env.ORS_DAILY_REQUESTS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : ORS_DAILY_REQUESTS_DEFAULT;
}

/** Throws QuotaGuardError when today's network requests (Berlin day) reached the cap. Fails closed. */
async function assertOrsQuota(): Promise<void> {
  const cap = orsDailyCap();
  let used: number;
  try {
    const admin = createSupabaseAdminClient();
    const { count, error } = await admin
      .from("api_calls")
      .select("id", { count: "exact", head: true })
      .eq("provider", "openrouteservice")
      .neq("cache", "hit")
      .gte("created_at", berlinMidnightUtc().toISOString());
    if (error) throw new Error("quota read failed");
    used = count ?? 0;
  } catch {
    throw new QuotaGuardError("ORS quota state unavailable");
  }
  if (used >= cap) throw new QuotaGuardError("ORS daily cap reached");
}

/** Stable key: origin (3 decimals, ~100 m) + hash of the sorted destination keys and their coordinates. */
export function driveCacheKey(origin: LonLat, places: readonly { key: string; lat: number; lon: number }[]): string {
  const ids = [...places]
    .map((p) => `${p.key}@${p.lat.toFixed(4)},${p.lon.toFixed(4)}`)
    .sort()
    .join("|");
  const h = createHash("sha256").update(ids).digest("hex").slice(0, 32);
  return cacheKey("matrix", 1, { lat: Number(origin.lat.toFixed(3)), lon: Number(origin.lon.toFixed(3)), p: h });
}

/**
 * One cached ORS matrix call: destination point → every place, by car. Returns null when ORS fails, the key is
 * missing or the quota is used up (the plan then generates without times). Never throws.
 */
export async function getDriveTimes(
  origin: LonLat,
  places: readonly { key: string; lat: number; lon: number }[],
  ctx: FactsCtx,
): Promise<DriveTimes | null> {
  const list = places.slice(0, ORS_MAX_DESTINATIONS);
  if (list.length === 0 || !process.env.OPENROUTESERVICE_API_KEY?.trim()) return null;
  try {
    const res = await cached({
      provider: "openrouteservice",
      endpoint: "matrix",
      key: driveCacheKey(origin, list),
      ttlSeconds: DRIVE_TTL_SECONDS,
      schema: Payload,
      ctx,
      fetcher: async () => {
        await assertOrsQuota();
        const r = await fetchDriveMatrix(origin, list);
        const data: Record<string, { min: number; km: number }> = {};
        r.drives.forEach((d, i) => {
          if (d) data[list[i].key] = d;
        });
        return { data, status: r.status, latencyMs: r.latencyMs };
      },
    });
    return res.ok ? { byKey: res.data, fetchedAt: res.fetchedAt } : null;
  } catch {
    return null;
  }
}
