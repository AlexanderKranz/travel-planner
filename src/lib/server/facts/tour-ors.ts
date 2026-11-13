import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  fetchMatrixFull,
  fetchRoute,
  fetchRouteSteps,
  type TourMatrix,
  type TourRoute,
  type TourRouteSteps,
} from "@/lib/integrations/openrouteservice";
import type { OrsTourProfile, RouteOption } from "@/lib/domain/tour";
import { cacheKey, cached, peekCache, type CacheCtx } from "../api-cache";
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
export function tourRouteKey(profile: OrsTourProfile, option: RouteOption, points: readonly TourPointRef[]): string {
  return cacheKey("tour-route", 1, { profile, route: option, h: sha(points.map(pointId).join("|")) });
}

/** `tour-steps` key: as `tour-route`, separate so the steps never enter the route cache or the tour result. */
export function tourStepsKey(profile: OrsTourProfile, option: RouteOption, points: readonly TourPointRef[]): string {
  return cacheKey("tour-steps", 1, { profile, route: option, h: sha(points.map(pointId).join("|")) });
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

/** `cache`: how `cached()` answered (hit, miss = fetched now, stale = expired row after a failed refresh). */
export type Fetched = { fetchedAt: string; stale: boolean; cache: "hit" | "miss" | "stale" };

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
    return m ? { ...m, fetchedAt: res.fetchedAt, stale: res.stale, cache: res.cache } : null;
  } catch {
    return null;
  }
}

/**
 * The cached matrix for these points, or null: cache read only, never a network call and no `api_calls` row (drop
 * proposals of a "keep my order" tour or of an unchanged tour, spec 7: 0 API calls). Expired rows count too: the
 * proposals are labelled approximate anyway. Never throws.
 */
export async function peekTourMatrix(profile: OrsTourProfile, points: readonly TourPointRef[]): Promise<TourMatrix | null> {
  const list = canonical(points);
  if (list.length < 2) return null;
  const hit = await peekCache({ provider: "openrouteservice", key: tourMatrixKey(profile, list), schema: MatrixPayload });
  return hit ? reindexMatrix(hit.data, points) : null;
}

/** A run's route, or `failed` (ORS down, 429, bucket used up, key missing): never a guessed time. */
export type TourRouteAnswer = (TourRoute & Fetched) | { result: "failed" };

/**
 * One Directions request per run of legs with the same profile and option, cached 90 days. `no_route` and
 * `not_routable` are cached answers like a route; a failure is not cached. Never throws.
 */
export async function getTourRoute(
  profile: OrsTourProfile,
  option: RouteOption,
  points: readonly TourPointRef[],
  ctx: CacheCtx,
  opts: { refresh?: boolean } = {},
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
      refresh: opts.refresh,
      fetcher: async () => {
        await assertOrsQuota("directions");
        const r = await fetchRoute(profile, points, option);
        return { data: r.route, status: r.status, latencyMs: r.latencyMs };
      },
    });
    if (!res.ok) return { result: "failed" };
    if (res.data.result === "ok" && res.data.legs.length !== points.length - 1) return { result: "failed" };
    return { ...res.data, fetchedAt: res.fetchedAt, stale: res.stale, cache: res.cache };
  } catch {
    return { result: "failed" };
  }
}

const Step = z.union([
  z.tuple([z.number().int().min(0).max(13), z.string().max(120), z.number().int().min(0), z.number().int().min(0)]),
  z.tuple([z.literal(7), z.string().max(120), z.number().int().min(0), z.number().int().min(0), z.number().int().min(1)]),
]);
const StepsPayload: z.ZodType<TourRouteSteps> = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("ok"),
    legs: z
      .array(z.object({ min: z.number().int().min(0), km: z.number().min(0), poly: z.string(), steps: z.array(Step).max(400) }))
      .min(1),
  }),
  z.object({ result: z.literal("no_route") }),
  z.object({ result: z.literal("not_routable"), point: z.number().int().min(0) }),
]);

export type TourStepsAnswer = (TourRouteSteps & Fetched) | { result: "failed" };

/**
 * A run's route with turn-by-turn steps, fetched only on request ("Wegbeschreibung", spec 17.1 [P2]), cached 90 days
 * under its own key and logged as `tour_steps` (Directions bucket). Never throws.
 */
export async function getTourSteps(
  profile: OrsTourProfile,
  option: RouteOption,
  points: readonly TourPointRef[],
  ctx: CacheCtx,
): Promise<TourStepsAnswer> {
  if (points.length < 2 || !process.env.OPENROUTESERVICE_API_KEY?.trim()) return { result: "failed" };
  try {
    const res = await cached<TourRouteSteps>({
      provider: "openrouteservice",
      endpoint: "tour_steps",
      key: tourStepsKey(profile, option, points),
      ttlSeconds: TOUR_ORS_TTL_SECONDS,
      schema: StepsPayload,
      ctx,
      fetcher: async () => {
        await assertOrsQuota("directions");
        const r = await fetchRouteSteps(profile, points, option);
        return { data: r.route, status: r.status, latencyMs: r.latencyMs };
      },
    });
    if (!res.ok) return { result: "failed" };
    if (res.data.result === "ok" && res.data.legs.length !== points.length - 1) return { result: "failed" };
    return { ...res.data, fetchedAt: res.fetchedAt, stale: res.stale, cache: res.cache };
  } catch {
    return { result: "failed" };
  }
}
