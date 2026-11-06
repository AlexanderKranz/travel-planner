import "server-only";
import { z } from "zod";
import type { FactsCtx } from "@/lib/domain/facts";
import { activityPlacesForGroup, activityPlacesSchema, type ActivityPlace } from "@/lib/facts/activity-places";
import { ACTIVITY_SOURCES, groupHasGeoapify, radiusForGroup, typesInGroup, type ActivityGroup } from "@/lib/facts/activity-types";
import { restaurantSchema, toRestaurants, type Restaurant } from "@/lib/facts/cuisine";
import { matchesFilter } from "@/lib/facts/places";
import { fetchPlaces, hasGeoapifyKey } from "@/lib/integrations/geoapify";
import { OVERPASS_CLIENT_TIMEOUT_MS, buildQuery, runQuery, type RawOsmElement } from "@/lib/integrations/overpass";
import { cacheKey, cached, type CachedResult } from "../api-cache";
import type { GeoDestination } from "./common";
import { assertGeoapifyQuota } from "./geoapify-quota";
import { MIN_QUERY_WINDOW_MS, PLACES_CACHE_ONLY, VIEW_BUDGET_MS } from "./places";

/** Same lifetime as other places (empty results are cached too). */
const TTL_SECONDS = 30 * 86400;
/** Restaurants within 2.5 km of a city centre, 5 km for a region (spec section 3). */
export const RESTAURANT_RADIUS_KM = { city: 2.5, region: 5 } as const;
/** Overpass `out` cap for restaurants (a city centre has 150-200 named ones within 2.5 km). */
const RESTAURANT_OVERPASS_LIMIT = 500;
/** Nearest restaurants kept in the cache; the cuisine filter and the cap of 12 are applied by the caller. */
export const RESTAURANT_POOL = 150;

export type ActivityGroupFacts = { group: ActivityGroup; radiusKm: number; places: ActivityPlace[] };
export type RestaurantFacts = { radiusKm: number; restaurants: Restaurant[] };

/** Restaurants within this radius of a given place (change requests, spec section 4). */
export const RESTAURANT_NEAR_RADIUS_KM = 1.5;

/**
 * Outcome of one lookup. The plan may only say "found nothing nearby" for `empty`:
 * `ok` = places found, `empty` = a successful lookup (fresh or cached) without a match, `error` = the lookup failed,
 * `skipped` = it was not attempted (no coordinates, or a cache-only run with nothing cached).
 */
export type LookupFact<D> =
  | { status: "ok" | "empty"; data: D; source: "osm"; sourceUrl: string; fetchedAt: string; stale: boolean }
  | { status: "error"; source: "osm" }
  | { status: "skipped"; reason: "no_location" | "cache_only" };
const OSM_URL = "https://www.openstreetmap.org/copyright";

function toLookupFact<T, D>(res: CachedResult<T[]>, attempted: boolean, data: (items: T[]) => D): LookupFact<D> {
  if (!res.ok) return attempted ? { status: "error", source: "osm" } : { status: "skipped", reason: "cache_only" };
  return { status: res.data.length ? "ok" : "empty", data: data(res.data), source: "osm", sourceUrl: OSM_URL, fetchedAt: res.fetchedAt, stale: res.stale };
}

type Opts = { budgetMs?: number };
type Spec<T> = {
  /** Cache key parts (anchor already rounded). */
  keyParams: Record<string, string | number>;
  filters: readonly string[];
  /** Geoapify category groups; null = Overpass only (no or incomplete mapping, or no key). */
  geoapify: readonly (readonly string[])[] | null;
  radiusKm: number;
  anchor: { lat: number; lon: number };
  overpassLimit?: number;
  process: (elements: readonly RawOsmElement[]) => T[];
  schema: z.ZodType<T[]>;
  ctx: FactsCtx;
  budgetMs: number;
};

/**
 * Cache first (an Overpass result), then Geoapify (about 1 s), then Overpass over the network (25-60 s), the order
 * and budget rules of `getPlacesFacts`: budget 0 = cache only; a network query only starts with at least
 * MIN_QUERY_WINDOW_MS left once another one has run.
 */
async function lookup<T>(s: Spec<T>): Promise<{ res: CachedResult<T[]>; attempted: boolean }> {
  const started = Date.now();
  let queried = 0;
  let attempted = false;
  const gate = () => {
    if (s.budgetMs === PLACES_CACHE_ONLY) return false;
    const left = s.budgetMs - (Date.now() - started);
    if (queried > 0 && left < Math.min(MIN_QUERY_WINDOW_MS, OVERPASS_CLIENT_TIMEOUT_MS)) return false;
    queried += 1;
    return true;
  };
  const overpass = (deadline: number, fetchAllowed: () => boolean) =>
    cached({
      provider: "overpass",
      endpoint: "interpreter",
      key: cacheKey("interpreter", 1, s.keyParams),
      ttlSeconds: TTL_SECONDS,
      schema: s.schema,
      ctx: s.ctx,
      fetchAllowed,
      fetcher: async () => {
        attempted = true;
        const r = await runQuery(buildQuery(s.filters, s.anchor, s.radiusKm * 1000, s.overpassLimit), { deadline });
        return { data: s.process(r.elements), status: r.status, latencyMs: r.latencyMs, variant: r.mirror };
      },
    });

  const hit = await overpass(0, () => false);
  if (hit.ok && hit.cache === "hit") return { res: hit, attempted };

  const groups = s.geoapify;
  if (groups && hasGeoapifyKey()) {
    const res = await cached({
      provider: "geoapify",
      endpoint: "places",
      key: cacheKey("places", 1, s.keyParams),
      ttlSeconds: TTL_SECONDS,
      schema: s.schema,
      ctx: s.ctx,
      fetchAllowed: gate,
      fetcher: async () => {
        attempted = true;
        await assertGeoapifyQuota();
        const r = await fetchPlaces(groups, s.anchor, s.radiusKm * 1000);
        const matching = r.elements.filter((e) => s.filters.some((f) => matchesFilter(e.tags, f)));
        return { data: s.process(matching), status: r.status, latencyMs: r.latencyMs, units: r.credits };
      },
    });
    if (res.ok) return { res, attempted };
  }
  const res = await overpass(started + s.budgetMs, gate);
  return { res, attempted };
}

const roundAnchor = (d: GeoDestination) => ({ lat: Number(d.lat.toFixed(3)), lon: Number(d.lon.toFixed(3)) });

/**
 * All places of one activity group around the destination (one union query for the group's filters, spec section 6).
 * The caller keeps the types it needs (`expandWish`). `dest` null (free-text destination) = skipped.
 * Not wired into the plan pipeline yet.
 */
export async function getActivityGroupFacts(
  group: ActivityGroup,
  dest: GeoDestination | null,
  ctx: FactsCtx,
  opts: Opts = {},
): Promise<LookupFact<ActivityGroupFacts>> {
  if (!dest) return { status: "skipped", reason: "no_location" };
  try {
    const anchor = roundAnchor(dest);
    const radiusKm = radiusForGroup(group);
    const types = typesInGroup(group);
    const { res, attempted } = await lookup<ActivityPlace>({
      keyParams: { kind: "activities", group, lat: anchor.lat, lon: anchor.lon, r: radiusKm },
      filters: types.flatMap((t) => ACTIVITY_SOURCES[t].filters),
      geoapify: groupHasGeoapify(group) ? types.map((t) => ACTIVITY_SOURCES[t].geoapify!) : null,
      radiusKm,
      anchor,
      process: (els) => activityPlacesForGroup(group, els, anchor),
      schema: activityPlacesSchema,
      ctx,
      budgetMs: opts.budgetMs ?? VIEW_BUDGET_MS,
    });
    return toLookupFact(res, attempted, (places) => ({ group, radiusKm, places }));
  } catch {
    return { status: "error", source: "osm" };
  }
}

/**
 * Named restaurants around the destination (2.5 km city, 5 km region), or within 1.5 km of `opts.near` (change
 * requests; cache key = rounded point + radius). Unfiltered, nearest RESTAURANT_POOL: cuisine filtering and ranking
 * happen per plan in `selectRestaurants`, so one cache entry serves every purpose. No point at all = skipped.
 */
export async function getRestaurantFacts(
  dest: GeoDestination | null,
  ctx: FactsCtx,
  opts: Opts & { near?: { lat: number; lon: number } } = {},
): Promise<LookupFact<RestaurantFacts>> {
  const radiusKm = opts.near ? RESTAURANT_NEAR_RADIUS_KM : dest ? RESTAURANT_RADIUS_KM[dest.kind] : 0;
  const point = opts.near ?? dest;
  if (!point) return { status: "skipped", reason: "no_location" };
  try {
    const anchor = { lat: Number(point.lat.toFixed(3)), lon: Number(point.lon.toFixed(3)) };
    const { res, attempted } = await lookup<Restaurant>({
      keyParams: { kind: "restaurants", lat: anchor.lat, lon: anchor.lon, r: radiusKm },
      filters: [`["amenity"="restaurant"]`],
      geoapify: [["catering.restaurant"]],
      radiusKm,
      anchor,
      overpassLimit: RESTAURANT_OVERPASS_LIMIT,
      process: (els) =>
        toRestaurants(els, anchor, radiusKm)
          .sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name))
          .slice(0, RESTAURANT_POOL),
      schema: z.array(restaurantSchema),
      ctx,
      budgetMs: opts.budgetMs ?? VIEW_BUDGET_MS,
    });
    return toLookupFact(res, attempted, (restaurants) => ({ radiusKm, restaurants }));
  } catch {
    return { status: "error", source: "osm" };
  }
}
