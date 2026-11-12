import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  fetchMatrixFull,
  fetchRoute,
  type OrsTourProfile,
  type TourMatrix,
  type TourRoute,
  type TourRouteOption,
} from "@/lib/integrations/openrouteservice";
import { cacheKey, cached, type CacheCtx } from "../api-cache";
import { assertOrsQuota } from "./ors-quota";

/**
 * Cached ORS calls of a city tour (spec docs/specs/city-tour.md section 11). Keys hold public points only (OSM,
 * GeoNames or Geoapify keys with coordinates), no owner, so the cache is shared across users. Logged in `api_calls`
 * as `tour_matrix` / `tour_route` (provider `openrouteservice`), which ors-quota.ts counts in the matrix and the
 * Directions bucket. The tour gate (`orsTourGate`) runs before; each call still asserts its bucket.
 */
export const TOUR_ORS_TTL_SECONDS = 90 * 86400;

export type TourPointRef = { key: string; lat: number; lon: number };

const pointId = (p: TourPointRef) => `${p.key}@${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** The distinct points of a tour in a canonical order (sorted ids), so the same set always gives the same matrix. */
function canonical(points: readonly TourPointRef[]): TourPointRef[] {
  const byId = new Map<string, TourPointRef>();
  for (const p of points) byId.set(pointId(p), p);
  return [...byId.keys()].sort().map((id) => byId.get(id)!);
}

/** `tour-matrix` key: profile + hash of the sorted `key@lat,lon` (5 dp); independent of the input order. */
export function tourMatrixKey(profile: OrsTourProfile, points: readonly TourPointRef[]): string {
  return cacheKey("tour-matrix", 1, { profile, h: sha(canonical(points).map(pointId).join("|")) });
}

/** `tour-route` key: profile + option + hash of the ordered points (the order is the route). */
export function tourRouteKey(profile: OrsTourProfile, option: TourRouteOption, points: readonly TourPointRef[]): string {
  return cacheKey("tour-route", 1, { profile, route: option, h: sha(points.map(pointId).join("|")) });
}

/** Stored matrix: in canonical order, with the point ids, so a cached matrix can be re-indexed for any input order. */
const MatrixPayload = z.object({
  ids: z.array(z.string()),
  durations: z.array(z.array(z.number().min(0).nullable())),
  snappedM: z.array(z.number().nullable()),
});
type MatrixPayload = z.infer<typeof MatrixPayload>;

const RoutePayload: z.ZodType<TourRoute> = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("ok"),
    legs: z.array(z.object({ min: z.number().int().min(0), km: z.number().min(0), poly: z.string() })).min(1),
  }),
  z.object({ result: z.literal("no_route") }),
  z.object({ result: z.literal("not_routable"), point: z.number().int().min(0) }),
]);

export type Fetched = { fetchedAt: string; stale: boolean };

/** Re-indexes a canonical matrix to the caller's order (duplicate points, e.g. start = end, share a row). */
export function reindexMatrix(m: MatrixPayload, points: readonly TourPointRef[]): TourMatrix | null {
  const idx = points.map((p) => m.ids.indexOf(pointId(p)));
  if (idx.some((i) => i < 0)) return null;
  return {
    durations: idx.map((i) => idx.map((j) => m.durations[i]?.[j] ?? null)),
    snappedM: idx.map((i) => m.snappedM[i] ?? null),
  };
}

/**
 * n x n durations (seconds) for the tour points, in the caller's order. Null when ORS fails, the key is missing or
 * the matrix bucket is used up: the caller then keeps the user's order or shows the tour as not computed. Never throws.
 */
export async function getTourMatrix(
  profile: OrsTourProfile,
  points: readonly TourPointRef[],
  ctx: CacheCtx,
): Promise<(TourMatrix & Fetched) | null> {
  const list = canonical(points);
  if (list.length < 2 || !process.env.OPENROUTESERVICE_API_KEY?.trim()) return null;
  try {
    const res = await cached<MatrixPayload>({
      provider: "openrouteservice",
      endpoint: "tour_matrix",
      key: tourMatrixKey(profile, list),
      ttlSeconds: TOUR_ORS_TTL_SECONDS,
      schema: MatrixPayload,
      ctx,
      fetcher: async () => {
        await assertOrsQuota("matrix");
        const r = await fetchMatrixFull(profile, list);
        return { data: { ids: list.map(pointId), ...r.matrix }, status: r.status, latencyMs: r.latencyMs };
      },
    });
    if (!res.ok) return null;
    const m = reindexMatrix(res.data, points);
    return m ? { ...m, fetchedAt: res.fetchedAt, stale: res.stale } : null;
  } catch {
    return null;
  }
}

/** A run's route, or `failed` (ORS down, 429, bucket used up, key missing): never a guessed time. */
export type TourRouteAnswer = (TourRoute & Fetched) | { result: "failed" };

/**
 * One Directions request per run of legs with the same profile and option, cached 90 days. `no_route` and
 * `not_routable` are cached answers like a route; a failure is not cached. Never throws.
 */
export async function getTourRoute(
  profile: OrsTourProfile,
  option: TourRouteOption,
  points: readonly TourPointRef[],
  ctx: CacheCtx,
): Promise<TourRouteAnswer> {
  if (points.length < 2 || !process.env.OPENROUTESERVICE_API_KEY?.trim()) return { result: "failed" };
  try {
    const res = await cached<TourRoute>({
      provider: "openrouteservice",
      endpoint: "tour_route",
      key: tourRouteKey(profile, option, points),
      ttlSeconds: TOUR_ORS_TTL_SECONDS,
      schema: RoutePayload,
      ctx,
      fetcher: async () => {
        await assertOrsQuota("directions");
        const r = await fetchRoute(profile, points, option);
        return { data: r.route, status: r.status, latencyMs: r.latencyMs };
      },
    });
    if (!res.ok) return { result: "failed" };
    if (res.data.result === "ok" && res.data.legs.length !== points.length - 1) return { result: "failed" };
    return { ...res.data, fetchedAt: res.fetchedAt, stale: res.stale };
  } catch {
    return { result: "failed" };
  }
}
