import type { InterestKey } from "@/lib/domain/interests";
import { isInterestKey } from "@/lib/facts/interest-sources";

/**
 * What the search can check per interest (spec find-destinations section 6 [D10]).
 * - place: OSM matches define the place; fewer than `min` drops the card
 * - common: the count is shown, never drops
 * - cache: the OSM query is too slow to run in a search; read from the cache only, else "not checked"
 * - none: no source
 */
export type VerifyClass = "place" | "common" | "cache" | "none";
export type Verifiability = { class: VerifyClass; min: number };

const place = (min = 1): Verifiability => ({ class: "place", min });
const common: Verifiability = { class: "common", min: 0 };
const cache: Verifiability = { class: "cache", min: 0 };
const none: Verifiability = { class: "none", min: 0 };

/** Compile-time complete: a new INTEREST_KEYS entry without a row fails typecheck. */
export const VERIFIABILITY: Record<InterestKey, Verifiability> = {
  golf: place(2),
  beach: place(),
  hiking: place(),
  wellness: place(),
  family_activities: place(),
  nature_wildlife: place(),
  cycling: place(),
  food_wine: place(1),
  city_sightseeing: common,
  museums: common,
  history: common,
  shopping: common,
  photography: common,
  skiing: cache,
  architecture: cache,
  water_sports: cache,
  christmas_markets: none,
  nightlife: none,
  cruise: none,
  festivals_events: none,
};

export const MAX_SEARCH_INTERESTS = 2;
const ORDER: Record<VerifyClass, number> = { place: 0, common: 1, cache: 2, none: 3 };

/** The interest keys among the strings of a purpose input, in order. The pseudo interest `general` is never one. */
export function interestKeysOf(interests: readonly string[]): InterestKey[] {
  return [...new Set(interests.filter(isInterestKey))];
}

/** At most 2 interests per search, those with a POI check first (stable within a class). */
export function selectSearchInterests(keys: readonly InterestKey[]): InterestKey[] {
  return keys
    .map((k, i) => ({ k, i }))
    .sort((a, b) => ORDER[VERIFIABILITY[a.k].class] - ORDER[VERIFIABILITY[b.k].class] || a.i - b.i)
    .slice(0, MAX_SEARCH_INTERESTS)
    .map((x) => x.k);
}
