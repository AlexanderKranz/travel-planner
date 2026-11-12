import "server-only";
import { berlinToday } from "@/lib/date";
import type { InterestOrGeneral, PlaceCandidate } from "@/lib/domain/facts";
import type { Landmark } from "@/lib/facts/landmarks";
import type { GeoPlace } from "@/lib/domain/geo";
import type { Locale } from "@/lib/domain/profile";
import { DEFAULT_RADIUS_KM } from "@/lib/domain/trip";
import { jobsForInterests, landmarksJob } from "@/lib/places-retry";
import type { GeoDestination } from "../facts/common";
import { getInterestGroups, PLACES_CACHE_ONLY, VIEW_BUDGET_MS } from "../facts/places";
import { enqueuePlaceRetries } from "../place-retries";
import { anchorOf, readLandmarks, scheduleLandmarkWarm } from "./landmarks";

/**
 * Verified city places for city tours (spec 3.1 source 1 and section 6): the city's landmarks (`./landmarks.ts`),
 * then interest places through `getInterestGroups` with `overpass: "cache_only"` (same cache keys as a trip to that
 * town). Overpass is never queried inline; with `network: true` the Geoapify fast path may fetch (cached 30 days).
 * What is not cached is warmed after the response or enqueued for the place retry job and reported as `pending`.
 */
export type CityPlace = { key: string; name: string; lat: number; lon: number; cat: string; url?: string };
export type CityPlaces = { places: CityPlace[]; pending: boolean; fetchedAt: string | null };

const OSM_TYPE = { node: "n", way: "w", relation: "r" } as const;

export const osmKeyOf = (c: Pick<PlaceCandidate | Landmark, "osmType" | "osmId">) => `osm:${OSM_TYPE[c.osmType]}${c.osmId}`;
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

/** Max places offered as suggestions in total (landmarks first, then up to half of it the trip's purpose interests). */
export const MAX_CITY_PLACES = 40;

/** Landmark → city place: OSM key and link, the name in the user's language. */
export function landmarkPlace(l: Landmark, locale: Locale): CityPlace {
  return {
    key: osmKeyOf(l),
    name: (l.names[locale] ?? l.name).slice(0, 120),
    lat: l.lat,
    lon: l.lon,
    cat: l.cat,
    url: `https://www.openstreetmap.org/${l.osmType}/${l.osmId}`,
  };
}

/**
 * City places for suggestions (`limit` MAX_CITY_PLACES) and sights near the route (MAX_LANDMARKS): the city's
 * landmarks by prominence (`./landmarks.ts`, cache only), then the places of the other interests (a linked trip's
 * purpose). While the landmark set is not cached yet, the `general` interest places stand in (cache + Geoapify fast
 * path, as before), the landmarks are warmed after the response, and the answer is `pending`.
 */
export async function cityPlaces(
  dest: GeoDestination,
  interests: readonly InterestOrGeneral[],
  a: { userId: string; locale: Locale; network: boolean; limit?: number },
): Promise<CityPlaces> {
  const limit = a.limit ?? MAX_CITY_PLACES;
  const landmarks = await readLandmarks(dest, { userId: a.userId });
  if (!landmarks || landmarks.needsWarm) {
    if (a.network) await scheduleLandmarkWarm(dest);
    else await enqueuePlaceRetries([landmarksJob(anchorOf(dest))]);
  }
  // No landmark set yet (or none in this town): the `general` interest places stand in.
  const rest: InterestOrGeneral[] = landmarks?.ranked.length
    ? interests.filter((k) => k !== "general")
    : ["general", ...interests.filter((k) => k !== "general")];
  const fromInterests = rest.length ? await interestPlaces(dest, rest, a) : { places: [], pending: false, dates: [] as string[] };

  const places = mergePlaces(
    (landmarks?.ranked ?? []).map((l) => landmarkPlace(l, a.locale)),
    fromInterests.places,
    limit,
  );
  const dates = [...fromInterests.dates, ...(landmarks ? [landmarks.fetchedAt] : [])];
  return {
    places,
    pending: !landmarks || !landmarks.prominence || fromInterests.pending,
    fetchedAt: dates.length ? [...dates].sort()[0] : null,
  };
}

/**
 * Landmarks first, then the purpose interest places with up to half of `limit` (the landmarks keep at least half).
 * An interest place that is already among the landmarks shown counts once and reserves no slot; slots the interests
 * do not fill go to further landmarks. Pure.
 */
export function mergePlaces(landmarks: readonly CityPlace[], interests: readonly CityPlace[], limit: number): CityPlace[] {
  const uniq = (list: readonly CityPlace[]) => list.filter((p, i) => list.findIndex((x) => x.key === p.key) === i);
  const lm = uniq(landmarks);
  const half = Math.floor(limit / 2);
  const sure = new Set(lm.slice(0, limit - half).map((p) => p.key));
  let extra = uniq(interests).filter((p) => !sure.has(p.key));
  const reserve = lm.length ? Math.min(extra.length, half) : 0;
  const head = lm.slice(0, limit - reserve);
  const shown = new Set(head.map((p) => p.key));
  extra = extra.filter((p) => !shown.has(p.key));
  const out = [...head, ...extra.slice(0, limit - head.length)];
  // Interests that turned out fewer than reserved: the next landmarks fill the list.
  for (const p of lm.slice(head.length)) {
    if (out.length >= limit) break;
    if (!out.some((x) => x.key === p.key)) out.push(p);
  }
  return out;
}

/** Interest places through `getInterestGroups` (Overpass cache only, Geoapify fast path with `network`). */
async function interestPlaces(
  dest: GeoDestination,
  keys: readonly InterestOrGeneral[],
  a: { userId: string; locale: Locale; network: boolean },
): Promise<{ places: CityPlace[]; pending: boolean; dates: string[] }> {
  const ctx = { userId: a.userId, locale: a.locale, today: berlinToday() };
  const groups = await getInterestGroups(dest, keys, ctx, a.network ? VIEW_BUDGET_MS : PLACES_CACHE_ONLY, {
    overpass: "cache_only",
  });
  const places: CityPlace[] = [];
  const dates: string[] = [];
  for (const g of groups) {
    if (g.status === "ok" || g.status === "empty") dates.push(g.fetchedAt);
    if (g.status !== "ok") continue;
    for (const c of g.candidates) {
      places.push({
        key: osmKeyOf(c),
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
  return { places, pending: jobs.length > 0, dates };
}
