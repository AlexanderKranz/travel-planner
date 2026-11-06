import "server-only";
import { z } from "zod";
import type { Fact, FactsCtx } from "@/lib/domain/facts";
import { activityPlacesForGroup, activityPlacesSchema, type ActivityPlace } from "@/lib/facts/activity-places";
import { ACTIVITY_SOURCES, groupHasGeoapify, radiusForGroup, typesInGroup, type ActivityGroup } from "@/lib/facts/activity-types";
import { restaurantSchema, toRestaurants, type Restaurant } from "@/lib/facts/cuisine";
import { matchesFilter } from "@/lib/facts/places";
import { fetchPlaces, hasGeoapifyKey } from "@/lib/integrations/geoapify";
import { OVERPASS_CLIENT_TIMEOUT_MS, buildQuery, runQuery, type RawOsmElement } from "@/lib/integrations/overpass";
import { cacheKey, cached, type CachedResult } from "../api-cache";
import { unavailable, type GeoDestination } from "./common";
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
async function lookup<T>(s: Spec<T>): Promise<CachedResult<T[]>> {
  const started = Date.now();
  let queried = 0;
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
        const r = await runQuery(buildQuery(s.filters, s.anchor, s.radiusKm * 1000, s.overpassLimit), { deadline });
        return { data: s.process(r.elements), status: r.status, latencyMs: r.latencyMs, variant: r.mirror };
      },
    });

  const hit = await overpass(0, () => false);
  if (hit.ok && hit.cache === "hit") return hit;

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
        await assertGeoapifyQuota();
        const r = await fetchPlaces(groups, s.anchor, s.radiusKm * 1000);
        const matching = r.elements.filter((e) => s.filters.some((f) => matchesFilter(e.tags, f)));
        return { data: s.process(matching), status: r.status, latencyMs: r.latencyMs, units: r.credits };
      },
    });
    if (res.ok) return res;
  }
  return overpass(started + s.budgetMs, gate);
}

const roundAnchor = (d: GeoDestination) => ({ lat: Number(d.lat.toFixed(3)), lon: Number(d.lon.toFixed(3)) });

/**
 * All places of one activity group around the destination (one union query for the group's filters, spec section 6).
 * The caller keeps the types it needs (`expandWish`). Not wired into the plan pipeline yet.
 */
export async function getActivityGroupFacts(
  group: ActivityGroup,
  dest: GeoDestination,
  ctx: FactsCtx,
  opts: Opts = {},
): Promise<Fact<ActivityGroupFacts>> {
  try {
    const anchor = roundAnchor(dest);
    const radiusKm = radiusForGroup(group);
    const types = typesInGroup(group);
    const res = await lookup<ActivityPlace>({
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
    if (!res.ok) return unavailable("provider_error", "osm");
    return {
      status: "ok",
      data: { group, radiusKm, places: res.data },
      source: "osm",
      sourceUrl: "https://www.openstreetmap.org/copyright",
      fetchedAt: res.fetchedAt,
      stale: res.stale,
    };
  } catch {
    return unavailable("provider_error", "osm");
  }
}

/**
 * Named restaurants around the destination, unfiltered (nearest RESTAURANT_POOL). Cuisine filtering and ranking
 * happen per plan in `selectRestaurants`, so one cache entry serves every purpose.
 */
export async function getRestaurantFacts(dest: GeoDestination, ctx: FactsCtx, opts: Opts = {}): Promise<Fact<RestaurantFacts>> {
  try {
    const anchor = roundAnchor(dest);
    const radiusKm = RESTAURANT_RADIUS_KM[dest.kind];
    const res = await lookup<Restaurant>({
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
    if (!res.ok) return unavailable("provider_error", "osm");
    return {
      status: "ok",
      data: { radiusKm, restaurants: res.data },
      source: "osm",
      sourceUrl: "https://www.openstreetmap.org/copyright",
      fetchedAt: res.fetchedAt,
      stale: res.stale,
    };
  } catch {
    return unavailable("provider_error", "osm");
  }
}
