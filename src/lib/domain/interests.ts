/** Static interest keys for the purpose wizard. Labels live in messages/*.json under `interests.<key>`. */
export const INTEREST_KEYS = [
  "golf",
  "christmas_markets",
  "beach",
  "hiking",
  "city_sightseeing",
  "museums",
  "food_wine",
  "nightlife",
  "wellness",
  "cruise",
  "family_activities",
  "nature_wildlife",
  "cycling",
  "skiing",
  "shopping",
  "architecture",
  "history",
  "photography",
  "festivals_events",
  "water_sports",
] as const;

export type InterestKey = (typeof INTEREST_KEYS)[number];
