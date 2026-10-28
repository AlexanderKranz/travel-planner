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
import { buildQuery, runQuery } from "@/lib/integrations/overpass";
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

/** Time left for starting new Overpass queries on a page view (maxDuration is 60 s). */
export const VIEW_BUDGET_MS = 40_000;

const inFlight = new Map<string, Promise<CachedResult<PlaceCandidate[]>>>();

function fetchCandidates(
  interest: InterestOrGeneral,
  anchor: { lat: number; lon: number },
  radiusKm: number,
  ctx: FactsCtx,
): Promise<CachedResult<PlaceCandidate[]>> {
  const src = sourceFor(interest);
  if (src.source !== "osm") return Promise.resolve({ ok: false, error: "provider_error" });
  const key = cacheKey("interpreter", 1, { interest, lat: anchor.lat, lon: anchor.lon, r: radiusKm });
  const existing = inFlight.get(key);
  if (existing) return existing;
  const p = cached({
    provider: "overpass",
    endpoint: "interpreter",
    key,
    ttlSeconds: 30 * 86400, // empty results are cached too
    schema: candidatesSchema,
    ctx,
    fetcher: async () => {
      const r = await runQuery(buildQuery(src.filters, anchor, radiusKm * 1000));
      return { data: rankCandidates(r.elements, src.filters, anchor), status: r.status, latencyMs: r.latencyMs };
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
    const { keys, customInterests } = interestsForTrip(purpose?.guided);
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
      if (queried > 0 && Date.now() - started > budgetMs) {
        groups.push({ interest, status: "error" });
        continue;
      }
      queried += 1;
      const res = await fetchCandidates(interest, anchor, radiusForInterest(interest, baseRadius), ctx);
      if (!res.ok) {
        groups.push({ interest, status: "error" });
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
