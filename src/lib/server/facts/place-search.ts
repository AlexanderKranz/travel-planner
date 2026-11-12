import "server-only";
import { z } from "zod";
import {
  AUTOCOMPLETE_MAX_CHARS,
  AUTOCOMPLETE_MIN_CHARS,
  PlaceId,
  cell,
  fetchAutocomplete,
  fetchPlaceDetails,
  normalizeQuery,
  type PlaceDetails,
  type PlaceSuggestion,
} from "@/lib/integrations/geoapify-autocomplete";
import { cacheKey, cached, type CacheCtx } from "../api-cache";
import { assertGeoapifyQuota } from "./geoapify-quota";

/**
 * Cached Geoapify place search for city tours (spec docs/specs/city-tour.md 3.1 and 11). Both calls cost 1 credit,
 * logged as `units` so the existing Geoapify guard (`assertGeoapifyQuota`, Berlin day, shared with Places) counts
 * them. Per-user rate limits (30/min, 200/day) belong to the search route, not here.
 */
export const AUTOCOMPLETE_TTL_SECONDS = 30 * 86400;
export const PLACE_DETAILS_TTL_SECONDS = 90 * 86400;

const Lang = z.string().regex(/^[a-z]{2}$/);

const Suggestion: z.ZodType<PlaceSuggestion> = z.object({
  key: z.string().regex(/^gfy:[0-9a-f]{32}$/),
  placeId: PlaceId,
  name: z.string().min(1).max(120),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  datasource: z.string(),
  address: z.string().optional(),
  category: z.string().optional(),
  distanceM: z.number().optional(),
});
const Suggestions = z.array(Suggestion);

const Details: z.ZodType<PlaceDetails> = z.object({
  osmKey: z.string().regex(/^osm:[nwr]\d+$/).nullable(),
  name: z.string().min(1).max(120),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  cat: z.string().max(40).optional(),
  openingHours: z.string().optional(),
  wikidata: z.string().optional(),
});

/** `autocomplete` key: normalized query, the 2-decimal cell of the search centre, and the language (spec 11). */
export function autocompleteKey(q: string, center: { lat: number; lon: number }, lang: string): string {
  const c = cell(center);
  return cacheKey("autocomplete", 1, { q: normalizeQuery(q), cell: `${c.lat.toFixed(2)},${c.lon.toFixed(2)}`, lang });
}

export function placeDetailsKey(placeId: string, lang: string): string {
  return cacheKey("place-details", 1, { id: placeId, lang });
}

export type SearchAnswer =
  | { ok: true; suggestions: PlaceSuggestion[]; fetchedAt: string; stale: boolean }
  | { ok: false; error: "invalid_query" | "unavailable" };

/**
 * Up to 8 places within 20 km of the city for a query of at least 3 characters, cached 30 days. Never throws;
 * Geoapify down, the key missing or the daily credits used up → `unavailable`.
 */
export async function autocompletePlaces(
  input: { q: string; lat: number; lon: number; lang: string },
  ctx: CacheCtx,
): Promise<SearchAnswer> {
  const q = normalizeQuery(input.q);
  const coordsOk = Math.abs(input.lat) <= 90 && Math.abs(input.lon) <= 180;
  if (q.length < AUTOCOMPLETE_MIN_CHARS || q.length > AUTOCOMPLETE_MAX_CHARS || !Lang.safeParse(input.lang).success || !coordsOk) {
    return { ok: false, error: "invalid_query" };
  }
  if (!process.env.GEOAPIFY_API_KEY?.trim()) return { ok: false, error: "unavailable" };
  try {
    const res = await cached<PlaceSuggestion[]>({
      provider: "geoapify",
      endpoint: "autocomplete",
      key: autocompleteKey(q, input, input.lang),
      ttlSeconds: AUTOCOMPLETE_TTL_SECONDS,
      schema: Suggestions,
      ctx,
      fetcher: async () => {
        await assertGeoapifyQuota();
        const r = await fetchAutocomplete({ ...input, q });
        return { data: r.suggestions, status: r.status, latencyMs: r.latencyMs, units: 1 };
      },
    });
    return res.ok
      ? { ok: true, suggestions: res.data, fetchedAt: res.fetchedAt, stale: res.stale }
      : { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

/**
 * OSM identity and tags of one search result, resolved once when the user adds it (1 credit, cached 90 days per
 * place_id and language). Null on any failure or an invalid id. Never throws.
 */
export async function placeDetails(
  placeId: string,
  lang: string,
  ctx: CacheCtx,
): Promise<(PlaceDetails & { fetchedAt: string }) | null> {
  if (!PlaceId.safeParse(placeId).success || !Lang.safeParse(lang).success) return null;
  if (!process.env.GEOAPIFY_API_KEY?.trim()) return null;
  try {
    const res = await cached<PlaceDetails>({
      provider: "geoapify",
      endpoint: "place_details",
      key: placeDetailsKey(placeId, lang),
      ttlSeconds: PLACE_DETAILS_TTL_SECONDS,
      schema: Details,
      ctx,
      fetcher: async () => {
        await assertGeoapifyQuota();
        const r = await fetchPlaceDetails(placeId, lang);
        return { data: r.details, status: r.status, latencyMs: r.latencyMs, units: 1 };
      },
    });
    return res.ok ? { ...res.data, fetchedAt: res.fetchedAt } : null;
  } catch {
    return null;
  }
}
