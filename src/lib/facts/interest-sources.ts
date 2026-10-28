import { INTEREST_KEYS, type InterestKey } from "@/lib/domain/interests";
import type { InterestOrGeneral } from "@/lib/domain/facts";
import { DEFAULT_RADIUS_KM } from "@/lib/domain/trip";
import type { Trip } from "@/lib/domain/trip";
import type { PurposeGuided } from "@/lib/domain/purpose";

/** Max 60 km regardless of trip radius or mapping (spec 3.5). */
export const MAX_RADIUS_KM = 60;
export const MAX_INTEREST_QUERIES = 4;

export type InterestSource =
  | { source: "osm"; filters: readonly string[]; minRadiusKm?: number }
  | { source: "none" };

const city = [
  `["tourism"~"^(attraction|viewpoint)$"]["wikidata"]`,
  `["historic"~"^(castle|monument|city_gate|fort)$"]["wikidata"]`,
  `["building"="cathedral"]["wikidata"]`,
] as const;

/** Compile-time complete: a new INTEREST_KEYS entry without a mapping fails typecheck. */
export const INTEREST_SOURCES: Record<InterestKey, InterestSource> = {
  golf: { source: "osm", filters: [`["leisure"="golf_course"]`], minRadiusKm: 40 },
  beach: { source: "osm", filters: [`["natural"="beach"]`] },
  hiking: { source: "osm", filters: [`["tourism"="viewpoint"]`, `["natural"="peak"]["wikidata"]`], minRadiusKm: 25 },
  city_sightseeing: { source: "osm", filters: city },
  museums: { source: "osm", filters: [`["tourism"~"^(museum|gallery)$"]`] },
  architecture: {
    source: "osm",
    filters: [`["building"~"^(cathedral|church|palace)$"]["wikidata"]`, `["historic"="castle"]["wikidata"]`],
  },
  history: {
    source: "osm",
    filters: [`["historic"~"^(castle|ruins|archaeological_site|fort|monument)$"]["wikidata"]`],
  },
  food_wine: { source: "osm", filters: [`["craft"~"^(winery|brewery)$"]`, `["amenity"="marketplace"]`] },
  wellness: { source: "osm", filters: [`["amenity"="public_bath"]`, `["leisure"="sauna"]`] },
  family_activities: {
    source: "osm",
    filters: [`["tourism"~"^(zoo|aquarium|theme_park)$"]`, `["leisure"="water_park"]`],
    minRadiusKm: 25,
  },
  nature_wildlife: {
    source: "osm",
    filters: [`["leisure"="nature_reserve"]["wikidata"]`, `["boundary"="national_park"]`],
    minRadiusKm: 40,
  },
  cycling: { source: "osm", filters: [`["amenity"="bicycle_rental"]`] },
  skiing: { source: "osm", filters: [`["landuse"="winter_sports"]`], minRadiusKm: 60 },
  shopping: { source: "osm", filters: [`["shop"~"^(mall|department_store)$"]`, `["amenity"="marketplace"]`] },
  photography: { source: "osm", filters: [`["tourism"="viewpoint"]`] },
  water_sports: {
    source: "osm",
    filters: [`["leisure"="marina"]`, `["sport"~"^(scuba_diving|surfing|kitesurfing|sailing)$"]`],
  },
  // [D12]: `["xmas:feature"="market"]` returned 0 elements around Passau (15 km, checked 2026-10-28) -> no source.
  christmas_markets: { source: "none" },
  nightlife: { source: "none" },
  cruise: { source: "none" },
  festivals_events: { source: "none" },
};

/** Pseudo key `general` = the city_sightseeing filters. */
export function sourceFor(key: InterestOrGeneral): InterestSource {
  return key === "general" ? INTEREST_SOURCES.city_sightseeing : INTEREST_SOURCES[key];
}

const known = new Set<string>(INTEREST_KEYS);
export const isInterestKey = (s: string): s is InterestKey => known.has(s);

/**
 * Keys in purpose order (unique), custom text interests separately. Without any known key: ["general"].
 * Keys with an OSM source are capped to MAX_INTEREST_QUERIES (first in purpose order); `none` keys are all
 * returned (they cost no query). If every known key is `none`, "general" is NOT added (user chose them).
 */
export function interestsForTrip(guided: PurposeGuided | null | undefined): {
  keys: InterestOrGeneral[];
  customInterests: string[];
} {
  const raw = guided?.interests ?? [];
  const keys: InterestKey[] = [];
  const custom: string[] = [];
  for (const i of raw) {
    if (isInterestKey(i)) {
      if (!keys.includes(i)) keys.push(i);
    } else if (!custom.includes(i)) custom.push(i);
  }
  if (keys.length === 0) return { keys: ["general"], customInterests: custom };
  let osm = 0;
  const kept = keys.filter((k) => {
    if (INTEREST_SOURCES[k].source !== "osm") return true;
    osm += 1;
    return osm <= MAX_INTEREST_QUERIES;
  });
  return { keys: kept, customInterests: custom };
}

/** max(trip radius ?? kind default, mapping minimum), capped at 60 km. */
export function radiusForInterest(key: InterestOrGeneral, tripRadiusKm: number): number {
  const s = sourceFor(key);
  const min = s.source === "osm" ? (s.minRadiusKm ?? 0) : 0;
  return Math.min(MAX_RADIUS_KM, Math.max(tripRadiusKm, min));
}

export function tripRadiusKm(dest: Extract<Trip["destination"], { lat: number }>): number {
  return dest.radiusKm ?? DEFAULT_RADIUS_KM[dest.kind];
}
