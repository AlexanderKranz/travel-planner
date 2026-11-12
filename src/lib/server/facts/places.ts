import "server-only";
import { z } from "zod";
import type {
  Fact,
  FactsCtx,
  InterestOrGeneral,
  PlaceCandidate,
  PlaceGroup,
  PlacesFacts,
} from "@/lib/domain/facts";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import { interestsForTrip, radiusForInterest, sourceFor, tripRadiusKm, type InterestExclude } from "@/lib/facts/interest-sources";
import { haversineKm, matchesFilter, rankCandidates } from "@/lib/facts/places";
import { overpassJob } from "@/lib/places-retry";
import { fetchPlaces, hasGeoapifyKey } from "@/lib/integrations/geoapify";
import { OVERPASS_CLIENT_TIMEOUT_MS, buildQuery, runQuery } from "@/lib/integrations/overpass";
import { cacheKey, cached, type CachedResult } from "../api-cache";
import { geoDestination, unavailable, type GeoDestination } from "./common";
import { assertGeoapifyQuota } from "./geoapify-quota";
import { cachedSitelinks, idsSitelinksKey, MAX_SITELINK_IDS, SITELINKS_BUDGET_MS } from "./sitelinks";

const candidateSchema = z.object({
  osmType: z.enum(["node", "way", "relation"]),
  osmId: z.number(),
  name: z.string(),
  names: z.object({ de: z.string().optional(), en: z.string().optional() }),
  category: z.string(),
  lat: z.number(),
  lon: z.number(),
  distanceKm: z.number(),
  wikidata: z.string().optional(),
  wikipedia: z.string().optional(),
  website: z.string().optional(),
  osmUrl: z.string(),
  openAir: z.literal(true).optional(),
});
const candidatesSchema = z.array(candidateSchema);
/** Empty results are cached too. */
const PLACES_TTL_SECONDS = 30 * 86400;

/**
 * Total time budget for one places request (route handler maxDuration is 300 s, minus margin). Cached interests
 * are always read, whatever the budget. A network query after the first one only starts with at least
 * MIN_QUERY_WINDOW_MS left (each query is cut at the deadline); the remaining interests are fetched by the next
 * request.
 */
export const VIEW_BUDGET_MS = 280_000;
/** Overpass answered in 25-60 s when measured (2026-10-28); less time than this is not worth a query. */
export const MIN_QUERY_WINDOW_MS = 45_000;
export const PLACES_REQUEST_BUDGET_MS = VIEW_BUDGET_MS;
/** Budget meaning "cache only, no network query" (plan generation right after the client's places request). */
export const PLACES_CACHE_ONLY = 0;

/** `via`: which source answered a fast lookup (an `overpassFirst` interest queues Overpass after a Geoapify answer). */
type FastResult = CachedResult<PlaceCandidate[]> & { via?: "overpass" | "geoapify" };

const inFlight = new Map<string, Promise<FastResult | null>>();

/** Concurrent requests for the same lookup on this instance (page loader + plan runner) share one promise. */
function shared<T extends FastResult | null>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const p = run().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

type Lookup = {
  interest: InterestOrGeneral;
  anchor: { lat: number; lon: number };
  radiusKm: number;
  ctx: FactsCtx;
  /** Find destinations only: use the interest's `discover` filters/categories (own cache key, no Overpass cache). */
  discover?: boolean;
};

/** Interests ranked by prominence (issue #172) have their own key version: lists cached before are not reused. */
const keyVersion = (interest: InterestOrGeneral) => {
  const src = sourceFor(interest);
  return src.source === "osm" && src.prominence ? 3 : 2;
};

const overpassKey = ({ interest, anchor, radiusKm }: Lookup) =>
  cacheKey("interpreter", keyVersion(interest), { interest, lat: anchor.lat, lon: anchor.lon, r: radiusKm });

/** A list ranked without the sitelinks it should have had (Wikidata down) is redone after a day, not 30. */
export const PLACES_DEGRADED_TTL_SECONDS = 86400;
/** Elements an Overpass query of a `prominence` interest may return (the default 150 is an arbitrary subset in big cities). */
export const PROMINENCE_QUERY_LIMIT = 1000;

/**
 * Sitelink counts for the Wikidata items among the elements (within the radius, the nearest MAX_SITELINK_IDS), cached
 * 90 days by the set of ids. `sitelinks` undefined when the interest has no `prominence` or there are no items (the
 * list is ranked as before, normally); `degraded` when Wikidata did not answer in time (ranked as before, cached for a
 * day only). Called only inside a fetcher, i.e. on a cache miss.
 */
async function sitelinksFor(
  l: Lookup,
  elements: readonly { lat: number; lon: number; tags: Record<string, string> }[],
  deadline: number,
): Promise<{ sitelinks?: Record<string, number>; degraded?: true }> {
  const src = sourceFor(l.interest);
  if (src.source !== "osm" || !src.prominence) return {};
  const near = elements
    .filter((e) => e.tags.name && /^Q\d{1,12}$/.test(e.tags.wikidata ?? ""))
    .map((e) => ({ q: e.tags.wikidata, d: haversineKm(l.anchor, e) }))
    .filter((x) => x.d <= l.radiusKm)
    .sort((a, b) => a.d - b.d);
  const ids = [...new Set(near.map((x) => x.q))].slice(0, MAX_SITELINK_IDS);
  if (!ids.length) return {};
  const res = await cachedSitelinks({ key: idsSitelinksKey(ids), ids, ctx: l.ctx, deadline: Math.min(deadline, Date.now() + SITELINKS_BUDGET_MS) });
  return res.ok ? { sitelinks: res.data } : { degraded: true };
}

/** Filters and Geoapify groups of a lookup: the discover variant where the interest has one, else the plan's. */
function sourceOf(l: Lookup) {
  const src = sourceFor(l.interest);
  if (src.source !== "osm") return null;
  if (l.discover && src.discover) return { distinct: false, ...src, ...src.discover, isDiscover: true as const };
  return { ...src, distinct: false, isDiscover: false as const };
}

function fromOverpass(l: Lookup, filters: readonly string[], exclude: InterestExclude | undefined, deadline: number, fetchAllowed: () => boolean) {
  return cached({
    provider: "overpass",
    endpoint: "interpreter",
    key: overpassKey(l),
    ttlSeconds: PLACES_TTL_SECONDS,
    schema: candidatesSchema,
    ctx: l.ctx,
    fetchAllowed,
    fetcher: async () => {
      const src = sourceFor(l.interest);
      const prominent = src.source === "osm" && src.prominence === true;
      // Prominence needs the whole set: the default element cap would hand back an arbitrary subset to rank.
      const query = prominent ? buildQuery(filters, l.anchor, l.radiusKm * 1000, PROMINENCE_QUERY_LIMIT) : buildQuery(filters, l.anchor, l.radiusKm * 1000);
      const r = await runQuery(query, { deadline });
      const { sitelinks, degraded } = await sitelinksFor(l, r.elements, Math.max(deadline, Date.now() + SITELINKS_BUDGET_MS));
      return {
        data: rankCandidates(r.elements, filters, l.anchor, exclude, l.radiusKm, { markOpenAir: true, ...(sitelinks ? { sitelinks } : {}) }),
        status: r.status,
        latencyMs: r.latencyMs,
        variant: r.mirror,
        ...(degraded ? { ttlSeconds: PLACES_DEGRADED_TTL_SECONDS } : {}),
      };
    },
  });
}

/**
 * Fast path, safe to run for all interests in parallel: an Overpass result already in the cache (keeps results
 * fetched before Geoapify existed), else Geoapify (about 1 s; the OSM filters are applied to its results in code).
 * null = not applicable (no key, no category mapping); a failed result = use the Overpass fallback.
 */
function fastCandidates(l: Lookup, networkAllowed: boolean): Promise<FastResult | null> {
  const src = sourceOf(l);
  if (!src || !src.geoapify || !hasGeoapifyKey()) return Promise.resolve(null);
  const groups = src.geoapify;
  return shared(`fast:${src.isDiscover ? "discover:" : ""}${overpassKey(l)}`, async () => {
    if (!src.isDiscover) {
      const hit = await fromOverpass(l, src.filters, src.exclude, 0, () => false);
      if (hit.ok && hit.cache === "hit") return { ...hit, via: "overpass" as const };
    }
    const res = await cached({
      provider: "geoapify",
      endpoint: "places",
      key: cacheKey("places", src.isDiscover ? 2 : keyVersion(l.interest), {
        interest: l.interest,
        lat: l.anchor.lat,
        lon: l.anchor.lon,
        r: l.radiusKm,
        ...(src.isDiscover ? { variant: "discover" } : {}),
      }),
      ttlSeconds: PLACES_TTL_SECONDS,
      schema: candidatesSchema,
      ctx: l.ctx,
      fetchAllowed: () => networkAllowed,
      fetcher: async () => {
        await assertGeoapifyQuota();
        const r = await fetchPlaces(groups, l.anchor, l.radiusKm * 1000);
        const matching = r.elements.filter((e) => src.filters.some((f) => matchesFilter(e.tags, f)));
        // The discover variant counts places; only the plan's lists are ranked by prominence.
        const { sitelinks, degraded } = src.isDiscover ? {} : await sitelinksFor(l, matching, Date.now() + SITELINKS_BUDGET_MS);
        return {
          data: rankCandidates(matching, src.filters, l.anchor, src.exclude, l.radiusKm, {
            distinct: src.distinct,
            markOpenAir: true,
            ...(sitelinks ? { sitelinks } : {}),
          }),
          status: r.status,
          latencyMs: r.latencyMs,
          units: r.credits,
          ...(degraded ? { ttlSeconds: PLACES_DEGRADED_TTL_SECONDS } : {}),
        };
      },
    });
    // Discover: the minimum must never be applied to an expired list after a failed refresh ("not checked" instead).
    // A successful empty response stays a real negative; a stale result without an attempt (network not allowed) is kept.
    if (src.isDiscover && networkAllowed && res.ok && res.cache === "stale") return { ok: false, error: "provider_error" } as const;
    return res.ok ? { ...res, via: "geoapify" as const } : res;
  });
}

/**
 * One interest around a point for the destination search (spec find-destinations section 5): the same cache keys as
 * `getPlacesFacts` (anchor rounded to 3 decimals, radius from `radiusForInterest` with the kind's default base), so
 * the trip made from a card finds the result already cached. Cache first, then Geoapify (unless `networkAllowed` is
 * false); Overpass is only ever read from its cache, never queried (25-60 s per query).
 * Returns the result (ok or a failed lookup) or null when the interest has no source.
 */
export async function getPlacesAt(
  interest: InterestOrGeneral,
  point: { lat: number; lon: number },
  baseRadiusKm: number,
  ctx: FactsCtx,
  opts: { networkAllowed: boolean },
): Promise<{ radiusKm: number; result: CachedResult<PlaceCandidate[]> } | null> {
  const src = sourceFor(interest);
  if (src.source !== "osm") return null;
  const l: Lookup = {
    interest,
    anchor: { lat: Number(point.lat.toFixed(3)), lon: Number(point.lon.toFixed(3)) },
    radiusKm: radiusForInterest(interest, baseRadiusKm),
    ctx,
    discover: true,
  };
  const fast = await fastCandidates(l, opts.networkAllowed);
  if (fast) return { radiusKm: l.radiusKm, result: fast };
  // The discover variant counts something else than the plan's cached Overpass areas: without Geoapify it is "not checked".
  if (src.discover) return { radiusKm: l.radiusKm, result: { ok: false, error: "provider_error" } };
  // No Geoapify mapping or key: whatever Overpass result is cached, never a network query.
  const cachedOnly = await shared(`overpass-cache:${overpassKey(l)}`, () => fromOverpass(l, src.filters, src.exclude, 0, () => false));
  return { radiusKm: l.radiusKm, result: cachedOnly };
}

/** Slow path: Overpass over the network (25-60 s per query). Sequential callers only (2 slots per IP). */
function overpassCandidates(l: Lookup, deadline: number, fetchAllowed: () => boolean): Promise<CachedResult<PlaceCandidate[]>> {
  const src = sourceFor(l.interest);
  if (src.source !== "osm") return Promise.resolve({ ok: false, error: "provider_error" });
  return shared(`overpass:${overpassKey(l)}`, () => fromOverpass(l, src.filters, src.exclude, deadline, fetchAllowed));
}

/** Overpass result from the cache only: never a network query, never joined to a network lookup in flight. */
function overpassCacheOnly(l: Lookup): Promise<CachedResult<PlaceCandidate[]>> {
  const src = sourceFor(l.interest);
  if (src.source !== "osm") return Promise.resolve({ ok: false, error: "provider_error" });
  return shared(`overpass-cache:${overpassKey(l)}`, () => fromOverpass(l, src.filters, src.exclude, 0, () => false));
}

/**
 * One interest lookup for the background retry worker: cache, then Geoapify, then one Overpass query over the
 * network within `budgetMs`. Same keys and rules as `getPlacesFacts`. Never throws.
 */
export async function retryInterestLookup(
  interest: InterestOrGeneral,
  point: { lat: number; lon: number },
  radiusKm: number,
  ctx: FactsCtx,
  budgetMs: number,
  /** `overpass`: skip the Geoapify fast path (an `overpassFirst` interest that Geoapify answered for now). */
  opts: { overpass?: boolean } = {},
): Promise<"ok" | "failed"> {
  try {
    const l: Lookup = { interest, anchor: { lat: Number(point.lat.toFixed(3)), lon: Number(point.lon.toFixed(3)) }, radiusKm, ctx };
    if (sourceFor(interest).source !== "osm") return "failed";
    if (!opts.overpass) {
      const fast = await fastCandidates(l, true);
      if (fast?.ok) return "ok";
    }
    let queried = false;
    const res = await overpassCandidates(l, Date.now() + budgetMs, () => (queried ? false : (queried = true)));
    // A failed refresh that served the expired entry (`stale`) is not done.
    return res.ok && !res.stale ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Geoapify (and cached results) for all interests in parallel first; whatever is still missing then goes to
 * Overpass one interest at a time, on purpose: Overpass allows 2 slots per IP and is slow (see research doc).
 * Same cache keys and radius rules for every caller (plan input, change requests). Throws only on unexpected errors.
 */
export async function getInterestGroups(
  dest: GeoDestination,
  keys: readonly InterestOrGeneral[],
  ctx: FactsCtx,
  budgetMs: number,
  /** `overpass: "cache_only"` (port places [P7]): cache and Geoapify, never an Overpass query over the network. */
  opts: { overpass?: "cache_only" } = {},
): Promise<PlaceGroup[]> {
  const started = Date.now();
  const baseRadius = tripRadiusKm(dest);
  const anchor = { lat: Number(dest.lat.toFixed(3)), lon: Number(dest.lon.toFixed(3)) };
  const groups: PlaceGroup[] = [];
  let queried = 0;
  const lookups = keys.map((interest) => ({ interest, anchor, radiusKm: radiusForInterest(interest, baseRadius), ctx }));
  const fast = await Promise.all(lookups.map((l) => fastCandidates(l, budgetMs !== PLACES_CACHE_ONLY)));
  // Geoapify stood in for an `overpassFirst` interest: queue its Overpass lookup (the retry job, never inline here).
  const overpassJobs = lookups.flatMap((l, i) => {
    const src = sourceFor(l.interest);
    return src.source === "osm" && src.overpassFirst && fast[i]?.ok && fast[i]?.via === "geoapify"
      ? [overpassJob(l.anchor, l.interest, l.radiusKm)]
      : [];
  });
  if (overpassJobs.length) {
    // Imported lazily: place-retries imports this module (retryInterestLookup).
    const { enqueuePlaceRetries } = await import("../place-retries");
    await enqueuePlaceRetries(overpassJobs);
  }
  for (const [i, interest] of keys.entries()) {
    if (sourceFor(interest).source === "none") {
      groups.push({ interest, status: "no_source" });
      continue;
    }
    // Budget gate only for real network queries: cached interests are always served (they cost no time).
    const fetchAllowed = () => {
      const left = budgetMs - (Date.now() - started);
      if (budgetMs === PLACES_CACHE_ONLY || opts.overpass === "cache_only") return false;
      if (queried > 0 && left < Math.min(MIN_QUERY_WINDOW_MS, OVERPASS_CLIENT_TIMEOUT_MS)) return false;
      queried += 1;
      return true;
    };
    const quick = fast[i];
    const cacheOnly = budgetMs === PLACES_CACHE_ONLY || opts.overpass === "cache_only";
    // Cache-only never joins an in-flight network lookup (a warm-up's `overpass:` promise): it would wait for Overpass.
    const res = quick?.ok ? quick : cacheOnly ? await overpassCacheOnly(lookups[i]) : await overpassCandidates(lookups[i], started + budgetMs, fetchAllowed);
    if (!res.ok) {
      groups.push({ interest, status: "error" }); // contract has no "pending": UI says "try again later"
      continue;
    }
    groups.push(
      res.data.length
        ? { interest, status: "ok", candidates: res.data, fetchedAt: res.fetchedAt, stale: res.stale }
        : { interest, status: "empty", fetchedAt: res.fetchedAt, stale: res.stale },
    );
  }
  return groups;
}

/** The purpose's interests around the trip destination (`getInterestGroups`) as one fact. Never throws. */
export async function getPlacesFacts(
  trip: Trip,
  purpose: TripPurpose | null,
  ctx: FactsCtx,
  opts: { budgetMs?: number } = {},
): Promise<Fact<PlacesFacts>> {
  try {
    const dest = geoDestination(trip);
    if (!dest) return unavailable("no_location");
    const { keys, customInterests } = interestsForTrip(purpose?.guided, purpose?.tags);
    const groups = await getInterestGroups(dest, keys, ctx, opts.budgetMs ?? VIEW_BUDGET_MS);
    if (groups.length > 0 && groups.every((g) => g.status === "error")) {
      return unavailable("provider_error", "osm");
    }
    const fetchedAts: string[] = [];
    let stale = false;
    for (const g of groups) {
      if (g.status !== "ok" && g.status !== "empty") continue;
      fetchedAts.push(g.fetchedAt);
      stale ||= g.stale;
    }
    const baseRadius = tripRadiusKm(dest);
    const radiusKm = Math.max(...keys.map((k) => radiusForInterest(k, baseRadius)));
    return {
      status: "ok",
      data: { radiusKm, groups, customInterests },
      source: "osm",
      sourceUrl: "https://www.openstreetmap.org/copyright",
      fetchedAt: fetchedAts.length ? [...fetchedAts].sort()[0] : new Date().toISOString(),
      stale,
    };
  } catch {
    return unavailable("provider_error", "osm");
  }
}
