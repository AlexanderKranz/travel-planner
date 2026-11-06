import "server-only";
import { z } from "zod";
import type { FactsCtx } from "@/lib/domain/facts";
import { activityPlaceSchema, activityPlacesForGroup, type ActivityPlace } from "@/lib/facts/activity-places";
import { ACTIVITY_SOURCES, groupHasGeoapify, radiusForGroup, typesInGroup, type ActivityGroup } from "@/lib/facts/activity-types";
import { cafeSchema, restaurantSchema, toCafes, toRestaurants, type Cafe, type Restaurant } from "@/lib/facts/cuisine";
import { matchesFilter } from "@/lib/facts/places";
import { GEOAPIFY_LIMIT, fetchPlaces, hasGeoapifyKey } from "@/lib/integrations/geoapify";
import { OVERPASS_CLIENT_TIMEOUT_MS, buildQuery, runQuery, type RawOsmElement } from "@/lib/integrations/overpass";
import { cacheKey, cached, type CachedResult } from "../api-cache";
import { logEvent } from "../events";
import type { GeoDestination } from "./common";
import { assertGeoapifyQuota } from "./geoapify-quota";
import { MIN_QUERY_WINDOW_MS, PLACES_CACHE_ONLY, VIEW_BUDGET_MS } from "./places";

/** Same lifetime as other places (empty results are cached too). */
const TTL_SECONDS = 30 * 86400;
/**
 * Version of the cache keys below. MUST be bumped whenever the processed shape, the filters, the radii or the caps
 * change: old rows are keyed by the old version and would otherwise be served with the wrong shape for 30 days.
 * 2: batches `{items, truncated}`, places with `types[]`, sport token regex, raised caps.
 * 3: new catalogue types (indoor_play, swimming, playground), `kidsTagged` on restaurants, cafe lookup.
 */
const CACHE_VERSION = 3;
/** Restaurants within 2.5 km of a city centre, 5 km for a region (spec section 3). */
export const RESTAURANT_RADIUS_KM = { city: 2.5, region: 5 } as const;
/**
 * Overpass `out` cap. A 15 km box around a big city holds hundreds of named bars, theatres or restaurants; with the
 * old 150 the only escape room could fall off an arbitrary cut and "empty" was cached for 30 days. A result that
 * still reaches the cap is flagged `truncated` and never reported as `empty`.
 */
export const OVERPASS_LIMIT = 1000;
/**
 * Geoapify page size for restaurants (the API allows 500; 1 credit per 20 places). 200 covers the pool of 150 with
 * margin (10 credits per uncached lookup); the default 100 would cut the pool and make a local-cuisine wish run
 * into `tooFew` falsely. Geoapify returns the nearest first (bias=proximity), so the pool is the nearest one.
 */
export const GEOAPIFY_RESTAURANT_LIMIT = 200;
/** Nearest restaurants kept in the cache; the cuisine filter and the cap of 12 are applied by the caller. */
export const RESTAURANT_POOL = 150;

export type ActivityGroupFacts = { group: ActivityGroup; radiusKm: number; places: ActivityPlace[]; truncated: boolean };
export type CafeFacts = { radiusKm: number; cafes: Cafe[]; truncated: boolean };
export type RestaurantFacts = { radiusKm: number; restaurants: Restaurant[]; truncated: boolean };

/** Nearest cafés kept in the cache; ranking and the cap of 6 happen in `selectCafes`. */
export const CAFE_POOL = 60;

/** Restaurants within this radius of a given place (change requests, spec section 4). */
export const RESTAURANT_NEAR_RADIUS_KM = 1.5;

/**
 * Outcome of one lookup. The plan may only say "found nothing nearby" for `empty`:
 * `ok` = places found, or a result cut off at the query cap (`data.truncated`, even with no match in it),
 * `empty` = a complete lookup (fresh or cached) without a match, `error` = the lookup failed,
 * `skipped` = it was not attempted (no coordinates, or a cache-only run with nothing cached).
 */
export type LookupFact<D> =
  | { status: "ok" | "empty"; data: D; source: "osm"; sourceUrl: string; fetchedAt: string; stale: boolean }
  | { status: "error"; source: "osm" }
  | { status: "skipped"; reason: "no_location" | "cache_only" };
const OSM_URL = "https://www.openstreetmap.org/copyright";

/** What is cached: the processed items and whether the source answer hit its cap. */
type Batch<T> = { items: T[]; truncated: boolean };
const batchSchema = <T>(item: z.ZodType<T>): z.ZodType<Batch<T>> => z.object({ items: z.array(item), truncated: z.boolean() });

/** `skipped` only when the network was not allowed (cache-only run / budget) and nothing was cached; any other failure is `error`. */
function toLookupFact<T, D>(
  looked: { res: CachedResult<Batch<T>>; attempted: boolean; denied: boolean },
  data: (batch: Batch<T>) => D,
): LookupFact<D> {
  const { res, attempted, denied } = looked;
  if (!res.ok) {
    return !attempted && denied && res.error === "timeout" ? { status: "skipped", reason: "cache_only" } : { status: "error", source: "osm" };
  }
  const empty = res.data.items.length === 0 && !res.data.truncated;
  return { status: empty ? "empty" : "ok", data: data(res.data), source: "osm", sourceUrl: OSM_URL, fetchedAt: res.fetchedAt, stale: res.stale };
}

type Opts = { budgetMs?: number };
type Spec<T> = {
  /** Cache key parts (anchor already rounded). */
  keyParams: Record<string, string | number>;
  /** For the truncation log event. */
  kind: string;
  filters: readonly string[];
  /** Own Overpass radius (km) per filter line; absent = `radiusKm`. */
  filterRadiusKm?: (filter: string) => number | undefined;
  /** Geoapify category groups; null = Overpass only (no or incomplete mapping, or no key). */
  geoapify: readonly (readonly string[])[] | null;
  geoapifyLimit?: number;
  radiusKm: number;
  anchor: { lat: number; lon: number };
  process: (elements: readonly RawOsmElement[]) => T[];
  schema: z.ZodType<Batch<T>>;
  ctx: FactsCtx;
  budgetMs: number;
};

/**
 * Cache first (an Overpass result), then Geoapify (about 1 s), then Overpass over the network (25-60 s), the order
 * and budget rules of `getPlacesFacts`: budget 0 = cache only; a network query only starts with at least
 * MIN_QUERY_WINDOW_MS left once another one has run. When every fetch fails, an expired cached result is still
 * served (stale) rather than an error.
 */
async function lookup<T>(s: Spec<T>): Promise<{ res: CachedResult<Batch<T>>; attempted: boolean; denied: boolean }> {
  const started = Date.now();
  let queried = 0;
  let attempted = false;
  let denied = false;
  const gate = () => {
    let ok = true;
    if (s.budgetMs === PLACES_CACHE_ONLY) ok = false;
    else if (queried > 0 && s.budgetMs - (Date.now() - started) < Math.min(MIN_QUERY_WINDOW_MS, OVERPASS_CLIENT_TIMEOUT_MS)) ok = false;
    if (ok) queried += 1;
    else denied = true;
    return ok;
  };
  const truncatedEvent = (source: string, limit: number) =>
    logEvent({ event: "places.truncated", level: "warn", userId: s.ctx.userId, props: { kind: s.kind, source, limit, radiusKm: s.radiusKm } });
  const overpass = (deadline: number, fetchAllowed: () => boolean) =>
    cached({
      provider: "overpass",
      endpoint: "interpreter",
      key: cacheKey("interpreter", CACHE_VERSION, s.keyParams),
      ttlSeconds: TTL_SECONDS,
      schema: s.schema,
      ctx: s.ctx,
      fetchAllowed,
      fetcher: async () => {
        attempted = true;
        const r = await runQuery(buildQuery(s.filters, s.anchor, s.radiusKm * 1000, OVERPASS_LIMIT, (f) => {
          const km = s.filterRadiusKm?.(f);
          return km === undefined ? undefined : km * 1000;
        }), { deadline });
        const truncated = r.elements.length >= OVERPASS_LIMIT;
        if (truncated) await truncatedEvent("overpass", OVERPASS_LIMIT);
        return { data: { items: s.process(r.elements), truncated }, status: r.status, latencyMs: r.latencyMs, variant: r.mirror };
      },
    });

  const hit = await overpass(0, () => false);
  if (hit.ok && hit.cache === "hit") return { res: hit, attempted, denied };

  const groups = s.geoapify;
  if (groups && hasGeoapifyKey()) {
    const limit = s.geoapifyLimit ?? GEOAPIFY_LIMIT;
    const res = await cached({
      provider: "geoapify",
      endpoint: "places",
      key: cacheKey("places", CACHE_VERSION, s.keyParams),
      ttlSeconds: TTL_SECONDS,
      schema: s.schema,
      ctx: s.ctx,
      fetchAllowed: gate,
      fetcher: async () => {
        attempted = true;
        await assertGeoapifyQuota();
        const r = await fetchPlaces(groups, s.anchor, s.radiusKm * 1000, limit);
        const matching = r.elements.filter((e) => s.filters.some((f) => matchesFilter(e.tags, f)));
        if (r.truncated) await truncatedEvent("geoapify", limit);
        return { data: { items: s.process(matching), truncated: r.truncated }, status: r.status, latencyMs: r.latencyMs, units: r.credits };
      },
    });
    if (res.ok) return { res, attempted, denied };
  }
  const res = await overpass(started + s.budgetMs, gate);
  if (!res.ok && hit.ok) return { res: hit, attempted, denied };
  return { res, attempted, denied };
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
    const looked = await lookup<ActivityPlace>({
      keyParams: { kind: "activities", group, lat: anchor.lat, lon: anchor.lon, r: radiusKm },
      kind: `activities:${group}`,
      filters: types.flatMap((t) => ACTIVITY_SOURCES[t].filters),
      // Each line searches only its own type's radius: dense playgrounds (3 km) must not fill the cap of a 25 km union.
      filterRadiusKm: (f) => {
        const t = types.find((x) => ACTIVITY_SOURCES[x].filters.includes(f));
        return t && Math.min(ACTIVITY_SOURCES[t].defaultRadiusKm, radiusKm);
      },
      geoapify: groupHasGeoapify(group) ? types.map((t) => ACTIVITY_SOURCES[t].geoapify!) : null,
      radiusKm,
      anchor,
      process: (els) => activityPlacesForGroup(group, els, anchor),
      schema: batchSchema(activityPlaceSchema),
      ctx,
      budgetMs: opts.budgetMs ?? VIEW_BUDGET_MS,
    });
    return toLookupFact(looked, (b) => ({ group, radiusKm, places: b.items, truncated: b.truncated }));
  } catch {
    return { status: "error", source: "osm" };
  }
}

/** Radius and anchor of a restaurant or café lookup: `near` wins (1.5 km), else the destination (2.5 km city, 5 km region). */
function eatingSpot(dest: GeoDestination | null, near?: { lat: number; lon: number }) {
  const point = near ?? dest;
  if (!point) return null;
  const radiusKm = near ? RESTAURANT_NEAR_RADIUS_KM : RESTAURANT_RADIUS_KM[dest!.kind];
  return { radiusKm, anchor: { lat: Number(point.lat.toFixed(3)), lon: Number(point.lon.toFixed(3)) } };
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
  const spot = eatingSpot(dest, opts.near);
  if (!spot) return { status: "skipped", reason: "no_location" };
  const { radiusKm, anchor } = spot;
  try {
    const looked = await lookup<Restaurant>({
      keyParams: { kind: "restaurants", lat: anchor.lat, lon: anchor.lon, r: radiusKm },
      kind: "restaurants",
      geoapifyLimit: GEOAPIFY_RESTAURANT_LIMIT,
      filters: [`["amenity"="restaurant"]`],
      geoapify: [["catering.restaurant"]],
      radiusKm,
      anchor,
      process: (els) =>
        toRestaurants(els, anchor, radiusKm)
          .sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name))
          .slice(0, RESTAURANT_POOL),
      schema: batchSchema(restaurantSchema),
      ctx,
      budgetMs: opts.budgetMs ?? VIEW_BUDGET_MS,
    });
    return toLookupFact(looked, (b) => ({ radiusKm, restaurants: b.items, truncated: b.truncated }));
  } catch {
    return { status: "error", source: "osm" };
  }
}

/**
 * Named cafés (`amenity=cafe`) around the destination or within 1.5 km of `opts.near`, same radii, statuses and
 * caching as restaurants (own cache key). Nearest CAFE_POOL, unranked beyond distance: `selectCafes` ranks and
 * caps at 6. Loaded only when a wish or change request asks for cafés (addendum A2).
 */
export async function getCafeFacts(
  dest: GeoDestination | null,
  ctx: FactsCtx,
  opts: Opts & { near?: { lat: number; lon: number } } = {},
): Promise<LookupFact<CafeFacts>> {
  const spot = eatingSpot(dest, opts.near);
  if (!spot) return { status: "skipped", reason: "no_location" };
  const { radiusKm, anchor } = spot;
  try {
    const looked = await lookup<Cafe>({
      keyParams: { kind: "cafes", lat: anchor.lat, lon: anchor.lon, r: radiusKm },
      kind: "cafes",
      filters: [`["amenity"="cafe"]`],
      geoapify: [["catering.cafe"]],
      radiusKm,
      anchor,
      process: (els) =>
        toCafes(els, anchor, radiusKm)
          .sort((a, b) => a.distanceKm - b.distanceKm || a.name.localeCompare(b.name))
          .slice(0, CAFE_POOL),
      schema: batchSchema(cafeSchema),
      ctx,
      budgetMs: opts.budgetMs ?? VIEW_BUDGET_MS,
    });
    return toLookupFact(looked, (b) => ({ radiusKm, cafes: b.items, truncated: b.truncated }));
  } catch {
    return { status: "error", source: "osm" };
  }
}
