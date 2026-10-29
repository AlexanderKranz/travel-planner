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
import { interestsForTrip, radiusForInterest, sourceFor, tripRadiusKm } from "@/lib/facts/interest-sources";
import { rankCandidates } from "@/lib/facts/places";
import { OVERPASS_CLIENT_TIMEOUT_MS, buildQuery, runQuery } from "@/lib/integrations/overpass";
import { cacheKey, cached, type CachedResult } from "../api-cache";
import { geoDestination, unavailable } from "./common";

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

const inFlight = new Map<string, Promise<CachedResult<PlaceCandidate[]>>>();

function fetchCandidates(
  interest: InterestOrGeneral,
  anchor: { lat: number; lon: number },
  radiusKm: number,
  ctx: FactsCtx,
  deadline: number,
  fetchAllowed: () => boolean,
): Promise<CachedResult<PlaceCandidate[]>> {
  const src = sourceFor(interest);
  if (src.source !== "osm") return Promise.resolve({ ok: false, error: "provider_error" });
  const key = cacheKey("interpreter", 2, { interest, lat: anchor.lat, lon: anchor.lon, r: radiusKm });
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = cached({
    provider: "overpass",
    endpoint: "interpreter",
    key,
    ttlSeconds: 30 * 86400, // empty results are cached too
    schema: candidatesSchema,
    ctx,
    fetchAllowed,
    fetcher: async () => {
      const r = await runQuery(buildQuery(src.filters, anchor, radiusKm * 1000), { deadline });
      return { data: rankCandidates(r.elements, src.filters, anchor, src.exclude, radiusKm), status: r.status, latencyMs: r.latencyMs, variant: r.mirror };
    },
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/** Sequential on purpose: Overpass allows 2 slots per IP and is slow (see research doc). */
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
    for (const interest of keys) {
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
      const res = await fetchCandidates(interest, anchor, radiusForInterest(interest, baseRadius), ctx, started + budgetMs, fetchAllowed);
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
