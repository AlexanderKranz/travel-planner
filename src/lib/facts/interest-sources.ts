import { INTEREST_KEYS, type InterestKey } from "@/lib/domain/interests";
import type { InterestOrGeneral } from "@/lib/domain/facts";
import { DEFAULT_RADIUS_KM } from "@/lib/domain/trip";
import type { Trip } from "@/lib/domain/trip";
import type { PurposeGuided } from "@/lib/domain/purpose";
import type { PurposeTags } from "@/lib/domain/plan";

/** Max 60 km regardless of trip radius or mapping (spec 3.5). */
export const MAX_RADIUS_KM = 60;
export const MAX_INTEREST_QUERIES = 4;

/** Deterministic post-filter per interest (applied in rankCandidates). */
export type InterestExclude = {
  /** Case-insensitive regex source; matching names are dropped. */
  nameRegex?: string;
  /** Drop node elements when at least one way/relation candidate remains (nodes are POIs, not areas). */
  dropNodesIfAreas?: boolean;
};

export type InterestSource =
  | {
      source: "osm";
      filters: readonly string[];
      /**
       * Geoapify category groups that together cover every filter line (a superset; the filters are applied to the
       * results in code). One request per group, so a broad category (tourism.attraction: mostly artworks) cannot
       * crowd the others out of the 100-place page. Absent = no reliable category mapping, Overpass only.
       */
      geoapify?: readonly (readonly string[])[];
      minRadiusKm?: number;
      exclude?: InterestExclude;
    }
  | { source: "none" };

const city = [
  `["tourism"~"^(attraction|viewpoint)$"]["wikidata"]`,
  `["historic"~"^(castle|monument|city_gate|fort)$"]["wikidata"]`,
  `["building"="cathedral"]["wikidata"]`,
] as const;
// tourism.attraction (viewpoints, but mostly artworks, which the city filters drop) gets its own request.
const cityGeoapify = [
  ["tourism.attraction"],
  [
    "tourism.sights.castle",
    "tourism.sights.memorial.monument",
    "tourism.sights.city_gate",
    "tourism.sights.fort",
    "tourism.sights.place_of_worship.cathedral",
  ],
] as const;

/** Compile-time complete: a new INTEREST_KEYS entry without a mapping fails typecheck. */
export const INTEREST_SOURCES: Record<InterestKey, InterestSource> = {
  golf: {
    source: "osm",
    // Query side: drop elements explicitly tagged as driving range / practice.
    filters: [`["leisure"="golf_course"]["golf"!~"^(driving_range|practice)$"]`],
    geoapify: [["sport.golf_course"]],
    minRadiusKm: 40,
    exclude: {
      nameRegex: "driving range|\\brange\\b|practice|lessons?\\b|clubhouse|club house|academy|academia|pitch ?(&|and|n)? ?putt|par ?3",
      dropNodesIfAreas: true,
    },
  },
  beach: { source: "osm", filters: [`["natural"="beach"]`], geoapify: [["beach"]] },
  hiking: {
    source: "osm",
    filters: [`["tourism"="viewpoint"]`, `["natural"="peak"]["wikidata"]`],
    geoapify: [["tourism.attraction.viewpoint", "natural.mountain.peak"]],
    minRadiusKm: 25,
  },
  city_sightseeing: { source: "osm", filters: city, geoapify: cityGeoapify },
  museums: {
    source: "osm",
    filters: [`["tourism"~"^(museum|gallery)$"]`],
    geoapify: [["entertainment.museum", "entertainment.culture.gallery"]],
  },
  architecture: {
    source: "osm",
    filters: [`["building"~"^(cathedral|church|palace)$"]["wikidata"]`, `["historic"="castle"]["wikidata"]`],
  },
  history: {
    source: "osm",
    filters: [`["historic"~"^(castle|ruins|archaeological_site|fort|monument)$"]["wikidata"]`],
    geoapify: [
      [
        "tourism.sights.castle",
        "tourism.sights.ruines",
        "tourism.sights.archaeological_site",
        "tourism.sights.fort",
        "tourism.sights.memorial.monument",
      ],
    ],
  },
  food_wine: {
    source: "osm",
    filters: [`["craft"~"^(winery|brewery)$"]`, `["amenity"="marketplace"]`],
    geoapify: [["production.winery", "production.brewery", "commercial.marketplace"]],
  },
  wellness: {
    source: "osm",
    filters: [`["amenity"="public_bath"]`, `["leisure"="sauna"]`],
    geoapify: [["leisure.spa.public_bath", "leisure.spa.sauna"]],
  },
  family_activities: {
    source: "osm",
    filters: [`["tourism"~"^(zoo|aquarium|theme_park)$"]`, `["leisure"="water_park"]`],
    geoapify: [["entertainment.zoo", "entertainment.aquarium", "entertainment.theme_park", "entertainment.water_park"]],
    minRadiusKm: 25,
  },
  nature_wildlife: {
    source: "osm",
    filters: [`["leisure"="nature_reserve"]["wikidata"]`, `["boundary"="national_park"]`],
    geoapify: [["leisure.park.nature_reserve", "national_park"]],
    minRadiusKm: 40,
  },
  cycling: { source: "osm", filters: [`["amenity"="bicycle_rental"]`], geoapify: [["rental.bicycle"]] },
  skiing: { source: "osm", filters: [`["landuse"="winter_sports"]`], minRadiusKm: 60 },
  shopping: {
    source: "osm",
    filters: [`["shop"~"^(mall|department_store)$"]`, `["amenity"="marketplace"]`],
    geoapify: [["commercial.shopping_mall", "commercial.department_store", "commercial.marketplace"]],
  },
  photography: { source: "osm", filters: [`["tourism"="viewpoint"]`], geoapify: [["tourism.attraction.viewpoint"]] },
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
 * Keys in purpose order (unique), then interest keys from Haiku tags (phase 3), custom text interests separately.
 * Without any known key: ["general"].
 * Keys with an OSM source are capped to MAX_INTEREST_QUERIES (guided keys first); `none` keys are all
 * returned (they cost no query). If every guided key is `none`, "general" is NOT added (user chose them).
 * When no key was chosen by the user (keys only from tags), "general" is always added: derived interests
 * must not drop the main sights.
 */
export function interestsForTrip(
  guided: PurposeGuided | null | undefined,
  tags?: Pick<PurposeTags, "interests"> | null,
): {
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
  const guidedCount = keys.length;
  for (const i of tags?.interests ?? []) {
    if (isInterestKey(i) && !keys.includes(i)) keys.push(i);
  }
  if (keys.length === 0) return { keys: ["general"], customInterests: custom };
  let osm = 0;
  const kept = keys.filter((k) => {
    if (INTEREST_SOURCES[k].source !== "osm") return true;
    osm += 1;
    return osm <= MAX_INTEREST_QUERIES;
  });
  if (guidedCount === 0) return { keys: [...kept, "general"], customInterests: custom };
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
