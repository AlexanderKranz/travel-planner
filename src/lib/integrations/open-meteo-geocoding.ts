/**
 * Open-Meteo Geocoding API (GeoNames data, keyless, CC BY 4.0).
 * Docs: https://open-meteo.com/en/docs/geocoding-api (checked 2026-10-28)
 * Verified live 2026-10-28: /v1/search returns no "results" key at all for zero hits;
 * /v1/get?id= answers HTTP 400 {"error":true,"reason":"Location ID not found."} for unknown ids.
 * Free tier: non-commercial, 10k calls/day. TTL: search 30 d, by id 365 d.
 */
import "server-only";
import { z } from "zod";
import type { GeoPlace } from "@/lib/domain/geo";
import { cacheKey, cached, type CachedResult } from "@/lib/server/api-cache";
import { HttpError, fetchJson } from "./http";

const BASE = "https://geocoding-api.open-meteo.com/v1";
export type GeoLang = "de" | "en";

const rawPlace = z.object({
  id: z.number().int(),
  name: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  feature_code: z.string().optional(),
  country_code: z.string().optional(),
  admin1: z.string().optional(),
  timezone: z.string().optional(),
  population: z.number().optional(),
});
const searchResponse = z.object({ results: z.array(rawPlace).optional() });

/** Normalized output; also the cached payload shape. */
export const geoPlaceSchema: z.ZodType<GeoPlace> = z.object({
  geoId: z.number().int(),
  name: z.string(),
  featureCode: z.string(),
  countryCode: z.string().nullable(),
  admin1: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
  timezone: z.string().nullable(),
  population: z.number().nullable(),
  suggestedKind: z.enum(["city", "region"]),
});

export function normalizePlace(raw: z.infer<typeof rawPlace>): GeoPlace {
  const featureCode = raw.feature_code ?? "";
  return {
    geoId: raw.id,
    name: raw.name,
    featureCode,
    countryCode: raw.country_code ?? null,
    admin1: raw.admin1 ?? null,
    lat: raw.latitude,
    lon: raw.longitude,
    timezone: raw.timezone ?? null,
    population: raw.population ?? null,
    suggestedKind: featureCode.startsWith("PPL") ? "city" : "region",
  };
}

export function parseSearchResponse(body: unknown): GeoPlace[] {
  return (searchResponse.parse(body).results ?? []).map(normalizePlace);
}

export function parsePlaceResponse(body: unknown): GeoPlace {
  return normalizePlace(rawPlace.parse(body));
}

const placesSchema = z.array(geoPlaceSchema);
const maybePlaceSchema = geoPlaceSchema.nullable();
const normQuery = (q: string) => q.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");

/** Search with the cache result (fetch date, stale flag, failure kind). Never throws. */
export function searchPlacesCached(
  q: string,
  lang: GeoLang,
  ctx: { userId: string | null } = { userId: null },
): Promise<CachedResult<GeoPlace[]>> {
  const query = normQuery(q);
  return cached({
    provider: "open_meteo_geocoding",
    endpoint: "search",
    key: cacheKey("search", 1, { q: query, lang }),
    ttlSeconds: 30 * 86400,
    schema: placesSchema,
    ctx,
    fetcher: async () => {
      const url = `${BASE}/search?name=${encodeURIComponent(query)}&count=8&language=${lang}&format=json`;
      const r = await fetchJson(url);
      return { data: parseSearchResponse(r.body), status: r.status, latencyMs: r.latencyMs };
    },
  });
}

/** Search places. Throws on provider error (the route turns that into `unavailable`). */
export async function searchPlaces(
  q: string,
  lang: GeoLang,
  ctx: { userId: string | null } = { userId: null },
): Promise<GeoPlace[]> {
  const res = await searchPlacesCached(q, lang, ctx);
  if (!res.ok) throw new Error(`geocoding search failed: ${res.error}`);
  return res.data;
}

/**
 * Resolve a GeoNames id (used by createTrip; coordinates are never client-supplied).
 * Returns null for an unknown id; throws on provider error.
 */
export async function getPlaceById(id: number, lang: GeoLang): Promise<GeoPlace | null> {
  const res = await cached({
    provider: "open_meteo_geocoding",
    endpoint: "get",
    key: cacheKey("get", 1, { id, lang }),
    ttlSeconds: 365 * 86400,
    schema: maybePlaceSchema,
    ctx: { userId: null },
    fetcher: async () => {
      try {
        const r = await fetchJson(`${BASE}/get?id=${encodeURIComponent(String(id))}&language=${lang}`);
        return { data: parsePlaceResponse(r.body), status: r.status, latencyMs: r.latencyMs };
      } catch (err) {
        // Unknown id is a valid answer, not a provider failure.
        if (err instanceof HttpError && err.status === 400) {
          return { data: null, status: 400, latencyMs: 0 };
        }
        throw err;
      }
    },
  });
  if (!res.ok) throw new Error(`geocoding get failed: ${res.error}`);
  return res.data;
}
