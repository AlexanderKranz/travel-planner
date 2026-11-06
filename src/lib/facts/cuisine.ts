import { z } from "zod";
import { haversineKm } from "@/lib/facts/places";
import type { RawOsmElement } from "@/lib/integrations/overpass";

/**
 * Cuisine values Haiku may use for `include` / `exclude` (spec activities-and-restaurants section 2): common OSM
 * `cuisine` values, checked against https://wiki.openstreetmap.org/wiki/Key:cuisine (2026-11-06).
 */
export const CUISINES = [
  "german", "regional", "bavarian", "swabian", "franconian", "austrian", "swiss", "spanish", "tapas", "andalusian",
  "italian", "pizza", "french", "portuguese", "dutch", "british", "greek", "croatian", "balkan", "turkish",
  "kebab", "burger", "chinese", "japanese", "sushi", "thai", "vietnamese", "indian", "mexican", "american",
  "steak_house", "seafood", "fish", "vegetarian", "vegan", "asian", "mediterranean", "sandwich", "chicken", "fast_food",
  "international", "lebanese", "korean",
] as const;
export const Cuisine = z.enum(CUISINES);
export type Cuisine = z.infer<typeof Cuisine>;

/**
 * OSM cuisine values that count as "local" per ISO 3166-1 alpha-2 country code. Regional dishes are mapped as
 * `regional` almost everywhere, so it is in every set; a country without an entry uses `regional` only.
 */
export const LOCAL_CUISINE: Record<string, readonly string[]> = {
  DE: ["german", "regional", "bavarian", "swabian", "franconian", "rhenish", "hessian", "saxon", "thuringian", "northern_german", "palatine"],
  AT: ["austrian", "regional", "viennese", "tyrolean", "styrian", "german", "bavarian"],
  CH: ["swiss", "regional", "fondue", "raclette", "german"],
  ES: ["spanish", "tapas", "regional", "andalusian", "catalan", "basque", "galician", "tapas_bar", "mediterranean"],
  IT: ["italian", "regional", "tuscan", "sicilian", "neapolitan", "roman", "pasta", "pizza"],
  FR: ["french", "regional", "provencal", "alsatian", "breton", "bistro", "brasserie", "crepe"],
  PT: ["portuguese", "regional", "seafood", "fish"],
  NL: ["dutch", "regional", "pancake", "pancakes"],
  GB: ["british", "regional", "english", "scottish", "welsh", "fish_and_chips", "pub"],
  GR: ["greek", "regional", "mediterranean", "seafood"],
  HR: ["croatian", "regional", "dalmatian", "istrian", "balkan", "seafood", "fish"],
};
export const FALLBACK_LOCAL_CUISINE: readonly string[] = ["regional"];

export function localCuisinesFor(countryCode: string | null | undefined): readonly string[] {
  return (countryCode && LOCAL_CUISINE[countryCode.toUpperCase()]) || FALLBACK_LOCAL_CUISINE;
}

/** Cuisines dropped when the purpose names no cuisine, and never part of "local" (spec section 3, steps 4 and 1). */
export const FAST_FOOD_CUISINES: ReadonlySet<string> = new Set(["pizza", "burger", "kebab", "sandwich", "chicken", "fast_food"]);

/** `italian;pizza` / `Italian; Pizza` -> ["italian", "pizza"]. Empty or missing -> []. */
export function parseCuisines(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(";")) {
    const v = part.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export const restaurantSchema = z.object({
  osmType: z.enum(["node", "way", "relation"]),
  osmId: z.number(),
  name: z.string(),
  cuisines: z.array(z.string()),
  lat: z.number(),
  lon: z.number(),
  distanceKm: z.number(),
  website: z.string().optional(),
  hasOpeningHours: z.boolean(),
  wikidata: z.string().optional(),
  osmUrl: z.string(),
});
export type Restaurant = z.infer<typeof restaurantSchema>;

/** Named restaurants within `maxKm` of the anchor, one per OSM element. No ranking or cap here, see selectRestaurants. */
export function toRestaurants(
  elements: readonly RawOsmElement[],
  anchor: { lat: number; lon: number },
  maxKm?: number,
): Restaurant[] {
  const out: Restaurant[] = [];
  const seen = new Set<string>();
  for (const e of elements) {
    const name = e.tags.name?.trim();
    if (!name || e.tags.amenity !== "restaurant") continue;
    const id = `${e.type}/${e.id}`;
    if (seen.has(id)) continue;
    const distance = haversineKm(anchor, e);
    if (maxKm !== undefined && distance > maxKm) continue;
    seen.add(id);
    const website = e.tags.website ?? e.tags["contact:website"];
    const r: Restaurant = {
      osmType: e.type,
      osmId: e.id,
      name,
      cuisines: parseCuisines(e.tags.cuisine),
      lat: e.lat,
      lon: e.lon,
      distanceKm: Math.round(distance * 10) / 10,
      hasOpeningHours: Boolean(e.tags.opening_hours),
      osmUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`,
    };
    if (website && /^https?:\/\//i.test(website)) r.website = website;
    if (e.tags.wikidata) r.wikidata = e.tags.wikidata;
    out.push(r);
  }
  return out;
}

export type CuisineWish = { local?: boolean; include?: readonly string[]; exclude?: readonly string[] };

export const MAX_RESTAURANTS = 12;
/** Fewer matches than this are reported as `tooFew` (the plan says so instead of padding). */
export const MIN_RESTAURANTS = 3;

export type RestaurantSelection = {
  restaurants: Restaurant[];
  /** Matches before the cap of MAX_RESTAURANTS. */
  matched: number;
  /** Fewer than MIN_RESTAURANTS matched (0 included): "only 2 local restaurants found". */
  tooFew: boolean;
};

/** Data completeness: website, opening hours, cuisine tag, wikidata (OSM has no ratings). */
export const completeness = (r: Restaurant): number =>
  Number(Boolean(r.website)) + Number(r.hasOpeningHours) + Number(r.cuisines.length > 0) + Number(Boolean(r.wikidata));

/**
 * Filter and rank restaurants (spec section 3). Pure.
 * 1. `local`: keep restaurants with a cuisine of the country's local set. `include` adds its own matches (a union:
 *    "local food, and Italian one night" must not end up empty). Without either, everything passes.
 * 2. `exclude` always drops matches.
 * 3. Fast-food cuisines (pizza, burger ...) are dropped unless `include` or the local set names them (pizza is local in Italy), so "local" never returns a
 *    pizzeria even when it is tagged `german;pizza`. Untagged restaurants are kept unless a cuisine was asked for.
 * Ranking: completeness, then distance, then name. At most MAX_RESTAURANTS.
 */
export function selectRestaurants(
  restaurants: readonly Restaurant[],
  wish: CuisineWish | null | undefined,
  countryCode: string | null | undefined,
): RestaurantSelection {
  const local = new Set(wish?.local ? localCuisinesFor(countryCode) : []);
  const include = new Set((wish?.include ?? []).map((c) => c.toLowerCase()));
  const exclude = new Set((wish?.exclude ?? []).map((c) => c.toLowerCase()));
  const asked = local.size > 0 || include.size > 0;
  const kept = restaurants.filter((r) => {
    if (asked && !r.cuisines.some((c) => local.has(c) || include.has(c))) return false;
    if (r.cuisines.some((c) => exclude.has(c))) return false;
    if (r.cuisines.some((c) => FAST_FOOD_CUISINES.has(c) && !include.has(c) && !local.has(c))) return false;
    return true;
  });
  kept.sort((a, b) => completeness(b) - completeness(a) || a.distanceKm - b.distanceKm || a.name.localeCompare(b.name));
  return { restaurants: kept.slice(0, MAX_RESTAURANTS), matched: kept.length, tooFew: kept.length < MIN_RESTAURANTS };
}
