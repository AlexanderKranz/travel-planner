import "server-only";
import { berlinToday } from "@/lib/date";
import type { InterestOrGeneral, PlaceCandidate } from "@/lib/domain/facts";
import type { GeoPlace } from "@/lib/domain/geo";
import type { Locale } from "@/lib/domain/profile";
import { DEFAULT_RADIUS_KM } from "@/lib/domain/trip";
import { jobsForInterests } from "@/lib/places-retry";
import type { GeoDestination } from "../facts/common";
import { getInterestGroups, PLACES_CACHE_ONLY, VIEW_BUDGET_MS } from "../facts/places";
import { enqueuePlaceRetries } from "../place-retries";

/**
 * Verified city places for city tours (spec 3.1 source 1 and section 6): the cached OSM places of a city, through
 * `getInterestGroups` with `overpass: "cache_only"`, so the same cache keys as a trip to that town. Overpass is never
 * queried inline; with `network: true` the Geoapify fast path may fetch (1 credit, cached 30 days). What is not
 * cached is enqueued for the existing place retry job and reported as `pending`.
 */
export type CityPlace = { key: string; name: string; lat: number; lon: number; cat: string; url?: string };
export type CityPlaces = { places: CityPlace[]; pending: boolean; fetchedAt: string | null };

const OSM_TYPE = { node: "n", way: "w", relation: "r" } as const;

export const osmKeyOf = (c: Pick<PlaceCandidate, "osmType" | "osmId">) => `osm:${OSM_TYPE[c.osmType]}${c.osmId}`;
/** "tourism=attraction" → "attraction": the tag value is the icon category (`TourPoint.cat`, at most 40). */
export const catOf = (category: string) => (category.split("=").pop() ?? category).slice(0, 40);

/** A destination like a city trip to that place: same anchor rounding and radius, so the place caches are shared. */
export function cityDestination(
  p: Pick<GeoPlace, "name" | "lat" | "lon"> & Partial<Pick<GeoPlace, "geoId" | "countryCode" | "admin1" | "timezone">>,
): GeoDestination {
  // Always "city": suggestions and sights of one tour must read the same cache keys (anchor, interest, radius).
  const kind = "city";
  return {
    kind,
    name: p.name,
    placeName: p.name,
    geoId: p.geoId ?? 0,
    countryCode: p.countryCode ?? null,
    admin1: p.admin1 ?? null,
    lat: p.lat,
    lon: p.lon,
    timezone: p.timezone ?? null,
    radiusKm: DEFAULT_RADIUS_KM[kind],
  };
}

/** Max places offered as suggestions or sight candidates (in `rankCandidates` order per interest). */
export const MAX_CITY_PLACES = 40;

export async function cityPlaces(
  dest: GeoDestination,
  interests: readonly InterestOrGeneral[],
  a: { userId: string; locale: Locale; network: boolean },
): Promise<CityPlaces> {
  const ctx = { userId: a.userId, locale: a.locale, today: berlinToday() };
  const keys = interests.includes("general") ? [...interests] : ["general" as const, ...interests];
  const groups = await getInterestGroups(dest, keys, ctx, a.network ? VIEW_BUDGET_MS : PLACES_CACHE_ONLY, {
    overpass: "cache_only",
  });
  const seen = new Set<string>();
  const places: CityPlace[] = [];
  const dates: string[] = [];
  for (const g of groups) {
    if (g.status === "ok" || g.status === "empty") dates.push(g.fetchedAt);
    if (g.status !== "ok") continue;
    for (const c of g.candidates) {
      const key = osmKeyOf(c);
      if (seen.has(key) || places.length >= MAX_CITY_PLACES) continue;
      seen.add(key);
      places.push({
        key,
        name: (c.names[a.locale] ?? c.name).slice(0, 120),
        lat: c.lat,
        lon: c.lon,
        cat: catOf(c.category),
        url: c.osmUrl,
      });
    }
  }
  const jobs = jobsForInterests(dest, groups);
  if (jobs.length) await enqueuePlaceRetries(jobs);
  return { places, pending: jobs.length > 0, fetchedAt: dates.length ? [...dates].sort()[0] : null };
}
