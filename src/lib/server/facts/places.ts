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
import { matchesFilter, rankCandidates } from "@/lib/facts/places";
import { fetchPlaces, hasGeoapifyKey } from "@/lib/integrations/geoapify";
import { OVERPASS_CLIENT_TIMEOUT_MS, buildQuery, runQuery } from "@/lib/integrations/overpass";
import { cacheKey, cached, type CachedResult } from "../api-cache";
import { geoDestination, unavailable } from "./common";
import { assertGeoapifyQuota } from "./geoapify-quota";

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

const inFlight = new Map<string, Promise<CachedResult<PlaceCandidate[]> | null>>();

/** Concurrent requests for the same lookup on this instance (page loader + plan runner) share one promise. */
function shared<T extends CachedResult<PlaceCandidate[]> | null>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const p = run().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

type Lookup = { interest: InterestOrGeneral; anchor: { lat: number; lon: number }; radiusKm: number; ctx: FactsCtx };

const overpassKey = ({ interest, anchor, radiusKm }: Lookup) =>
  cacheKey("interpreter", 2, { interest, lat: anchor.lat, lon: anchor.lon, r: radiusKm });

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
      const r = await runQuery(buildQuery(filters, l.anchor, l.radiusKm * 1000), { deadline });
      return { data: rankCandidates(r.elements, filters, l.anchor, exclude, l.radiusKm), status: r.status, latencyMs: r.latencyMs, variant: r.mirror };
    },
  });
}

/**
 * Fast path, safe to run for all interests in parallel: an Overpass result already in the cache (keeps results
 * fetched before Geoapify existed), else Geoapify (about 1 s; the OSM filters are applied to its results in code).
 * null = not applicable (no key, no category mapping); a failed result = use the Overpass fallback.
 */
function fastCandidates(l: Lookup, networkAllowed: boolean): Promise<CachedResult<PlaceCandidate[]> | null> {
  const src = sourceFor(l.interest);
  if (src.source !== "osm" || !src.geoapify || !hasGeoapifyKey()) return Promise.resolve(null);
  const groups = src.geoapify;
  return shared(`fast:${overpassKey(l)}`, async () => {
    const hit = await fromOverpass(l, src.filters, src.exclude, 0, () => false);
    if (hit.ok && hit.cache === "hit") return hit;
    return cached({
      provider: "geoapify",
      endpoint: "places",
      key: cacheKey("places", 2, { interest: l.interest, lat: l.anchor.lat, lon: l.anchor.lon, r: l.radiusKm }),
      ttlSeconds: PLACES_TTL_SECONDS,
      schema: candidatesSchema,
      ctx: l.ctx,
      fetchAllowed: () => networkAllowed,
      fetcher: async () => {
        await assertGeoapifyQuota();
        const r = await fetchPlaces(groups, l.anchor, l.radiusKm * 1000);
        const matching = r.elements.filter((e) => src.filters.some((f) => matchesFilter(e.tags, f)));
        return { data: rankCandidates(matching, src.filters, l.anchor, src.exclude, l.radiusKm), status: r.status, latencyMs: r.latencyMs, units: r.credits };
      },
    });
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
  };
  const fast = await fastCandidates(l, opts.networkAllowed);
  if (fast) return { radiusKm: l.radiusKm, result: fast };
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

/**
 * Geoapify (and cached results) for all interests in parallel first; whatever is still missing then goes to
 * Overpass one interest at a time, on purpose: Overpass allows 2 slots per IP and is slow (see research doc).
 */
export async function getPlacesFacts(
  trip: Trip,
  purpose: TripPurpose | null,
  ctx: FactsCtx,
  opts: { budgetMs?: number } = {},
): Promise<Fact<PlacesFacts>> {
  try {
    const dest = geoDestination(trip);
    if (!dest) return unavailable("no_location");
    const budgetMs = opts.budgetMs ?? VIEW_BUDGET_MS;
    const started = Date.now();
    const { keys, customInterests } = interestsForTrip(purpose?.guided, purpose?.tags);
    const baseRadius = tripRadiusKm(dest);
    const anchor = { lat: Number(dest.lat.toFixed(3)), lon: Number(dest.lon.toFixed(3)) };
    const groups: PlaceGroup[] = [];
    const fetchedAts: string[] = [];
    let stale = false;
    let queried = 0;
    const lookups = keys.map((interest) => ({ interest, anchor, radiusKm: radiusForInterest(interest, baseRadius), ctx }));
    const fast = await Promise.all(lookups.map((l) => fastCandidates(l, budgetMs !== PLACES_CACHE_ONLY)));
    for (const [i, interest] of keys.entries()) {
      if (sourceFor(interest).source === "none") {
        groups.push({ interest, status: "no_source" });
        continue;
      }
      // Budget gate only for real network queries: cached interests are always served (they cost no time).
      const fetchAllowed = () => {
        const left = budgetMs - (Date.now() - started);
        if (budgetMs === PLACES_CACHE_ONLY) return false;
        if (queried > 0 && left < Math.min(MIN_QUERY_WINDOW_MS, OVERPASS_CLIENT_TIMEOUT_MS)) return false;
        queried += 1;
        return true;
      };
      const quick = fast[i];
      const res = quick?.ok ? quick : await overpassCandidates(lookups[i], started + budgetMs, fetchAllowed);
      if (!res.ok) {
        groups.push({ interest, status: "error" }); // contract has no "pending": UI says "try again later"
        continue;
      }
      fetchedAts.push(res.fetchedAt);
      stale ||= res.stale;
      groups.push(
        res.data.length
          ? { interest, status: "ok", candidates: res.data, fetchedAt: res.fetchedAt, stale: res.stale }
          : { interest, status: "empty", fetchedAt: res.fetchedAt, stale: res.stale },
      );
    }
    if (groups.length > 0 && groups.every((g) => g.status === "error")) {
      return unavailable("provider_error", "osm");
    }
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
