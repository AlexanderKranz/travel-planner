import "server-only";
import { z } from "zod";
import type { FactsCtx } from "@/lib/domain/facts";
import { activityPlaceSchema, activityPlacesForGroup, mergeActivityPlaces, type ActivityPlace } from "@/lib/facts/activity-places";
import { ACTIVITY_SOURCES, radiusForGroup, splitGroupTypes, typesInGroup, type ActivityGroup, type ActivityType } from "@/lib/facts/activity-types";
import { cafeSchema, restaurantSchema, toCafes, toRestaurants, type Cafe, type Restaurant } from "@/lib/facts/cuisine";
import { matchesFilter } from "@/lib/facts/places";
import { GEOAPIFY_LIMIT, GEOAPIFY_TIMEOUT_MS, fetchPlaces, hasGeoapifyKey } from "@/lib/integrations/geoapify";
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
 * Activity groups have their own version (they are cached per source part since 4, see below).
 */
const CACHE_VERSION = 3;
/**
 * Cache version of activity group lookups. 4: a group is looked up in two parts (types with a Geoapify category via
 * Geoapify, one request per type; the others via Overpass), each cached under its own key (`part`, `t` = its types)
 * and with `cutTypes` (types whose Geoapify page hit its limit).
 */
const ACTIVITY_CACHE_VERSION = 4;
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

/**
 * Outcome per catalogue type of a group lookup (see `ActivityGroupFacts.typeStatus`). `unrequested` = no wish asked
 * for the type and its source part was not fetched (only a cached row would have been used): neither pending nor
 * "nothing found".
 */
export type TypeStatus = "ok" | "empty" | "error" | "skipped" | "cut" | "unrequested";
export type ActivityGroupFacts = {
  group: ActivityGroup;
  radiusKm: number;
  places: ActivityPlace[];
  truncated: boolean;
  /**
   * Per type of the group (every type is present), so the plan can tell what was really checked:
   * `ok` = at least one place of the type found; `empty` = its source answered completely with none ("nothing
   * found" may be claimed); `cut` = its answer hit the query cap without one (unknown, never "nothing found");
   * `error` = its source failed; `skipped` = not attempted (cache-only run / budget, nothing cached);
   * `unrequested` = no wish asked for it, so its part was not fetched.
   */
  typeStatus: Record<ActivityType, TypeStatus>;
  /** true = at least one source part failed or was skipped: `places` are the other part's, never read `empty` into the missing types. */
  partial: boolean;
};
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

/**
 * What is cached: the processed items, whether the source answer hit its cap and (Geoapify per-type requests) which
 * types did. `skippedTypes` (types whose request was not started for lack of budget) only ever appears in an
 * uncached result: such a batch is never written to the cache.
 */
type Batch<T> = { items: T[]; truncated: boolean; cutTypes?: string[]; skippedTypes?: string[] };
const batchSchema = <T>(item: z.ZodType<T>): z.ZodType<Batch<T>> =>
  z.object({ items: z.array(item), truncated: z.boolean(), cutTypes: z.array(z.string()).optional(), skippedTypes: z.array(z.string()).optional() });

/** Thrown by a fetcher whose answer is incomplete (types not started): `cached()` then stores nothing but logs the credits. */
class IncompleteAnswer extends Error {
  constructor(readonly units: number) {
    super("incomplete");
    this.name = "IncompleteAnswer";
  }
}

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

/**
 * `overpass: "cache_only"` (port places [P7]): cache and Geoapify as usual, but never an Overpass query over the
 * network (25-60 s). A miss is then `skipped` (`cache_only`), like a run with no budget left.
 */
type Opts = { budgetMs?: number; overpass?: "cache_only" };
type GeoapifyAnswer = { elements: RawOsmElement[]; status: number; latencyMs: number; credits: number; truncated: boolean; cutTypes?: string[]; skippedTypes?: string[] };
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
  /**
   * Own Geoapify fetch (activity parts: one request per type, `deadline` = end of this lookup's budget); default one
   * request per category group in `geoapify`.
   */
  geoapifyFetch?: (limit: number, deadline: number) => Promise<GeoapifyAnswer>;
  /** Cache version of this lookup's keys; default CACHE_VERSION. */
  cacheVersion?: number;
  radiusKm: number;
  anchor: { lat: number; lon: number };
  process: (elements: readonly RawOsmElement[]) => T[];
  schema: z.ZodType<Batch<T>>;
  ctx: FactsCtx;
  budgetMs: number;
  /** No Overpass query over the network (Geoapify and the caches still work). */
  overpassCacheOnly?: boolean;
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
      key: cacheKey("interpreter", s.cacheVersion ?? CACHE_VERSION, s.keyParams),
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
    // An answer with types left unstarted (budget) is used for this request but never cached.
    let incomplete: Batch<T> | null = null;
    const res = await cached({
      provider: "geoapify",
      endpoint: "places",
      key: cacheKey("places", s.cacheVersion ?? CACHE_VERSION, s.keyParams),
      ttlSeconds: TTL_SECONDS,
      schema: s.schema,
      ctx: s.ctx,
      fetchAllowed: gate,
      fetcher: async () => {
        attempted = true;
        await assertGeoapifyQuota();
        const r: GeoapifyAnswer = s.geoapifyFetch ? await s.geoapifyFetch(limit, started + s.budgetMs) : await fetchPlaces(groups, s.anchor, s.radiusKm * 1000, limit);
        const cutTypes = r.cutTypes;
        const matching = r.elements.filter((e) => s.filters.some((f) => matchesFilter(e.tags, f)));
        if (r.truncated) await truncatedEvent("geoapify", limit);
        const data: Batch<T> = { items: s.process(matching), truncated: r.truncated, ...(cutTypes ? { cutTypes } : {}) };
        if (r.skippedTypes?.length) {
          incomplete = { ...data, skippedTypes: r.skippedTypes };
          throw new IncompleteAnswer(r.credits);
        }
        return { data, status: r.status, latencyMs: r.latencyMs, units: r.credits };
      },
    });
    if (res.ok) return { res, attempted, denied };
    if (incomplete) return { res: { ok: true, data: incomplete, fetchedAt: new Date().toISOString(), stale: false, cache: "miss" }, attempted, denied };
  }
  const overpassGate = s.overpassCacheOnly
    ? () => {
        denied = true;
        return false;
      }
    : gate;
  const res = await overpass(started + s.budgetMs, overpassGate);
  if (!res.ok && hit.ok) return { res: hit, attempted, denied };
  return { res, attempted, denied };
}

const roundAnchor = (d: GeoDestination) => ({ lat: Number(d.lat.toFixed(3)), lon: Number(d.lon.toFixed(3)) });

/** One source part of a group lookup: the types it covers and its own outcome. */
type PartData = { places: ActivityPlace[]; truncated: boolean; cutTypes?: string[]; skippedTypes?: string[] };
/** `unrequested`: no wished type in this part, so it was read from the cache only; a miss is not a failure. */
export type GroupPart = { types: ActivityType[]; fact: LookupFact<PartData>; unrequested?: true };

/** Geoapify requests of one part run at most this many at a time (free plan: 5 requests/s; several lookups may overlap). */
export const GEOAPIFY_CONCURRENCY = 2;

/**
 * Geoapify for several types: one request per type, each with the type's own categories and its own radius (a
 * playground only 3 km, not the 25 km of the group) and page limit. One credit per started 20 places per type; in
 * return a dense type (theatres) cannot fill the page and crowd out a sparse one (escape rooms), and `cutTypes`
 * names exactly the types whose page was full. A failure after earlier types succeeded carries their credits as
 * `units`, so the daily cap still counts them.
 * Requests run GEOAPIFY_CONCURRENCY at a time. The first one always starts (like the lookup gate); a later one only
 * with at least one GEOAPIFY_TIMEOUT_MS left before `deadline`. Types never started are `skippedTypes`.
 */
async function fetchGeoapifyTypes(types: readonly ActivityType[], anchor: { lat: number; lon: number }, groupRadiusKm: number, limit: number, deadline: number) {
  const answers = new Map<ActivityType, Awaited<ReturnType<typeof fetchPlaces>>>();
  let credits = 0;
  let failure: unknown = null;
  let next = 0;
  let started = 0;
  const worker = async () => {
    while (failure === null && next < types.length) {
      if (started > 0 && deadline - Date.now() < GEOAPIFY_TIMEOUT_MS) return;
      const t = types[next++];
      started += 1;
      const { geoapify, defaultRadiusKm } = ACTIVITY_SOURCES[t];
      try {
        const r = await fetchPlaces([geoapify!], anchor, Math.min(defaultRadiusKm, groupRadiusKm) * 1000, limit);
        credits += r.credits;
        answers.set(t, r);
      } catch (err) {
        credits += err !== null && typeof err === "object" && "units" in err && typeof err.units === "number" ? err.units : 0;
        if (failure === null) failure = err ?? new Error("geoapify");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(GEOAPIFY_CONCURRENCY, types.length) }, worker));
  if (failure !== null) {
    if (credits > 0 && typeof failure === "object") Object.assign(failure as object, { units: credits });
    throw failure;
  }
  const byId = new Map<string, RawOsmElement>();
  const cutTypes: ActivityType[] = [];
  const skippedTypes: ActivityType[] = [];
  let latencyMs = 0;
  let status = 200;
  // Catalogue order, independent of which request finished first.
  for (const t of types) {
    const r = answers.get(t);
    if (!r) {
      skippedTypes.push(t);
      continue;
    }
    latencyMs = Math.max(latencyMs, r.latencyMs);
    status = r.status;
    if (r.truncated) cutTypes.push(t);
    for (const e of r.elements) byId.set(`${e.type}/${e.id}`, e);
  }
  return {
    elements: [...byId.values()], status, latencyMs, credits, truncated: cutTypes.length > 0, cutTypes,
    ...(skippedTypes.length ? { skippedTypes } : {}),
  };
}

/**
 * One source part of a group: the given types, either Geoapify first (with the Overpass fallback of `lookup`) or
 * Overpass only. Own cache keys (`part`, `t`), so the Geoapify part, the Overpass-only part and a keyless
 * all-Overpass lookup never share a row.
 */
async function lookupPart(
  group: ActivityGroup,
  types: ActivityType[],
  viaGeoapify: boolean,
  anchor: { lat: number; lon: number },
  ctx: FactsCtx,
  budgetMs: number,
): Promise<GroupPart> {
  const radiusKm = radiusForGroup(group, types);
  const looked = await lookup<ActivityPlace>({
    keyParams: { kind: "activities", group, part: viaGeoapify ? "geo" : "osm", t: types.join(","), lat: anchor.lat, lon: anchor.lon, r: radiusKm },
    kind: `activities:${group}`,
    filters: types.flatMap((t) => ACTIVITY_SOURCES[t].filters),
    // Each line searches only its own type's radius: dense playgrounds (3 km) must not fill the cap of a 25 km union.
    filterRadiusKm: (f) => {
      const t = types.find((x) => ACTIVITY_SOURCES[x].filters.includes(f));
      return t && Math.min(ACTIVITY_SOURCES[t].defaultRadiusKm, radiusKm);
    },
    geoapify: viaGeoapify ? types.map((t) => ACTIVITY_SOURCES[t].geoapify!) : null,
    geoapifyFetch: (limit, deadline) => fetchGeoapifyTypes(types, anchor, radiusKm, limit, deadline),
    cacheVersion: ACTIVITY_CACHE_VERSION,
    radiusKm,
    anchor,
    process: (els) => activityPlacesForGroup(group, els, anchor, types),
    schema: batchSchema(activityPlaceSchema),
    ctx,
    budgetMs,
  });
  return {
    types,
    fact: toLookupFact(looked, (b) => ({
      places: b.items,
      truncated: b.truncated,
      ...(b.cutTypes ? { cutTypes: b.cutTypes } : {}),
      ...(b.skippedTypes ? { skippedTypes: b.skippedTypes } : {}),
    })),
  };
}

/**
 * Merges the source parts into one fact. A part failing does not discard the other's places:
 * - every part ok/empty: `ok`, or `empty` when no part found anything and none was cut;
 * - some part ok/empty, another error/skipped: `ok` with `partial: true` (never `empty`), the failed part's types
 *   `error`/`skipped` in `typeStatus`;
 * - nothing succeeded: `skipped` when every part was skipped, else `error`.
 * An unrequested part (no wished type, cache only) that missed gives its types `unrequested` and counts for nothing
 * else: not partial, not failed. Types a part left unstarted (`skippedTypes`) are `skipped` and make it partial.
 */
export function mergeGroupParts(group: ActivityGroup, radiusKm: number, parts: readonly GroupPart[]): LookupFact<ActivityGroupFacts> {
  const notAsked = (p: GroupPart) => p.unrequested === true && p.fact.status !== "ok" && p.fact.status !== "empty";
  const asked = parts.filter((p) => !notAsked(p));
  const done: { fact: Extract<LookupFact<PartData>, { status: "ok" | "empty" }> }[] = [];
  for (const p of asked) if (p.fact.status === "ok" || p.fact.status === "empty") done.push({ fact: p.fact });
  if (done.length === 0) {
    const skipped = asked.every((p) => p.fact.status === "skipped");
    return skipped ? { status: "skipped", reason: "cache_only" } : { status: "error", source: "osm" };
  }
  const typeStatus = {} as Record<ActivityType, TypeStatus>;
  for (const p of parts) {
    const f = p.fact;
    for (const t of p.types) {
      if (notAsked(p)) typeStatus[t] = "unrequested";
      else if (f.status === "error" || f.status === "skipped") typeStatus[t] = f.status;
      else if (f.data.skippedTypes?.includes(t)) typeStatus[t] = "skipped";
      else {
        const found = f.data.places.some((pl) => pl.types.includes(t));
        const cut = f.data.cutTypes ? f.data.cutTypes.includes(t) : f.data.truncated;
        typeStatus[t] = found ? "ok" : cut ? "cut" : "empty";
      }
    }
  }
  const partial = done.length < asked.length || done.some((d) => (d.fact.data.skippedTypes?.length ?? 0) > 0);
  const places = mergeActivityPlaces(group, done.map((d) => d.fact.data.places));
  const truncated = done.some((d) => d.fact.data.truncated);
  return {
    status: places.length === 0 && !truncated && !partial ? "empty" : "ok",
    data: { group, radiusKm, places, truncated, typeStatus, partial },
    source: "osm",
    sourceUrl: OSM_URL,
    fetchedAt: done.map((d) => d.fact.fetchedAt).sort()[0],
    stale: done.some((d) => d.fact.stale),
  };
}

/**
 * All places of one activity group around the destination (spec section 6). With a Geoapify key the group is looked
 * up in two parts: the types with a Geoapify category via Geoapify (about 1 s per type; Overpass as fallback when it
 * fails), then the remaining types in one Overpass union (the slow one, last, with what is left of the budget).
 * Without a key it is one Overpass union of all types. The caller keeps the types it needs (`expandWish`) and reads
 * `data.typeStatus` to see which of them were really checked. `dest` null (free-text destination) = skipped.
 * `opts.wanted`: the wished types; a part with none of them is read from the cache only (no network) and its types
 * are `unrequested` on a miss. Cache keys stay per part (the full type list of the part), wanted or not.
 * A second part with less than MIN_QUERY_WINDOW_MS left is cache only too (`skipped` on a miss, not `error`).
 */
export async function getActivityGroupFacts(
  group: ActivityGroup,
  dest: GeoDestination | null,
  ctx: FactsCtx,
  opts: Opts & { wanted?: readonly ActivityType[] } = {},
): Promise<LookupFact<ActivityGroupFacts>> {
  if (!dest) return { status: "skipped", reason: "no_location" };
  try {
    const anchor = roundAnchor(dest);
    const started = Date.now();
    const budgetMs = opts.budgetMs ?? VIEW_BUDGET_MS;
    const split = splitGroupTypes(group, hasGeoapifyKey());
    // Wishes that name nothing of this group (should not happen) fall back to the whole group.
    const wanted = opts.wanted?.some((t) => typesInGroup(group).includes(t)) ? new Set(opts.wanted) : null;
    const isWanted = (types: readonly ActivityType[]) => !wanted || types.some((t) => wanted.has(t));
    const part = async (types: ActivityType[], viaGeoapify: boolean, budget: number): Promise<GroupPart> =>
      isWanted(types)
        ? lookupPart(group, types, viaGeoapify, anchor, ctx, budget)
        : { ...(await lookupPart(group, types, viaGeoapify, anchor, ctx, PLACES_CACHE_ONLY)), unrequested: true };
    const parts: GroupPart[] = [];
    if (split.geoapify.length) parts.push(await part(split.geoapify, true, budgetMs));
    if (split.overpass.length) {
      // Cache only stays cache only; after a first part, less than one query window left is cache only as well.
      const rest = budgetMs - (Date.now() - started);
      // Only a first part that went to the network counts; an unrequested (cache-only) part used no budget.
      const ranFirst = parts.some((p) => !p.unrequested);
      const left = budgetMs === PLACES_CACHE_ONLY || (ranFirst && rest < MIN_QUERY_WINDOW_MS) ? PLACES_CACHE_ONLY : Math.max(PLACES_CACHE_ONLY, rest);
      parts.push(await part(split.overpass, false, left));
    }
    return mergeGroupParts(group, radiusForGroup(group), parts);
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
      overpassCacheOnly: opts.overpass === "cache_only",
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
      overpassCacheOnly: opts.overpass === "cache_only",
    });
    return toLookupFact(looked, (b) => ({ radiusKm, cafes: b.items, truncated: b.truncated }));
  } catch {
    return { status: "error", source: "osm" };
  }
}
