import type { ActivityGroupLookup, RestaurantLookup } from "@/lib/domain/facts";
import type { NeedPlaces } from "@/lib/domain/plan";
import type { Locale } from "@/lib/domain/profile";
import { groupsForWishes, isActivityType, type ActivityGroup, type ActivityType } from "@/lib/facts/activity-types";
import { CUISINES, type CuisineWish } from "@/lib/facts/cuisine";
import { activitiesInput, maxId, restaurantsInput, selectWishPlaces } from "./activities-input";
import type { PlanInputStored } from "./input";

/** Label of the wish a change request adds to the input (the model links it to FEEDBACK). */
export const FEEDBACK_WISH = "FEEDBACK";

/** A validated `needPlaces`: what code loads before the second patch call (activities spec section 4). */
export type NeedPlacesRequest = {
  types: ActivityType[];
  groups: ActivityGroup[];
  restaurants?: { cuisine?: CuisineWish; near?: { id: string; lat: number; lon: number } };
};

const cuisines = (xs: readonly string[] | undefined) =>
  [...new Set((xs ?? []).map((x) => String(x).trim().toLowerCase()))].filter((x) => (CUISINES as readonly string[]).includes(x));

/**
 * Model `needPlaces` -> what to load, or null when nothing loadable is left. Unknown types and cuisines are dropped;
 * `near` must be an id of the stored input (a place with coordinates), else it is ignored and restaurants are
 * loaded around the destination point. Pure.
 */
export function resolveNeedPlaces(need: NeedPlaces | undefined, stored: PlanInputStored): NeedPlacesRequest | null {
  if (!need) return null;
  const types = [...new Set((need.types ?? []).map((t) => String(t).trim()).filter(isActivityType))];
  const groups = groupsForWishes([{ types, open: false }]);
  let restaurants: NeedPlacesRequest["restaurants"];
  if (need.restaurants) {
    const c = need.restaurants.cuisine;
    const include = cuisines(c?.include);
    const exclude = cuisines(c?.exclude);
    const cuisine =
      c && (c.local !== undefined || include.length || exclude.length)
        ? { ...(c.local !== undefined ? { local: c.local } : {}), include, exclude }
        : undefined;
    const nearId = need.restaurants.near?.trim();
    // Own keys only: a model-supplied "constructor" or "__proto__" must never resolve.
    const hit = nearId && Object.hasOwn(stored.index, nearId) ? stored.index[nearId] : undefined;
    restaurants = {
      ...(cuisine ? { cuisine } : {}),
      ...(hit && nearId ? { near: { id: nearId, lat: hit.place.lat, lon: hit.place.lon } } : {}),
    };
  }
  if (!types.length && !restaurants) return null;
  return { types, groups, ...(restaurants ? { restaurants } : {}) };
}

/**
 * The change request's cuisine on top of the earlier wish: `local`, `include` and `exclude` the request leaves
 * unset are kept ("and no pizza" keeps "local food"). Pure.
 */
export function mergeCuisine(
  prev: { local?: boolean; include?: string[]; exclude?: string[] } | undefined,
  next: CuisineWish | undefined,
): CuisineWish | undefined {
  if (!prev && !next) return undefined;
  return {
    local: next?.local ?? prev?.local === true,
    include: next?.include?.length ? [...next.include] : [...(prev?.include ?? [])],
    exclude: next?.exclude?.length ? [...next.exclude] : [...(prev?.exclude ?? [])],
  };
}

/**
 * Stored input + loaded places -> the input of the new version (pure). Activity places of the requested types are
 * added as one more wish labelled FEEDBACK_WISH. Restaurants around the destination replace the RESTAURANTS block
 * (the request's cuisine merged with the old block's wish, `mergeCuisine`); restaurants around a
 * place go into `restaurantsNear`. Every old index entry stays, so refs of untouched days remain valid.
 */
export function extendInput(
  stored: PlanInputStored,
  req: NeedPlacesRequest,
  loaded: { activities: ActivityGroupLookup[]; restaurants?: RestaurantLookup },
  a: { lang: Locale; countryCode?: string | null },
): PlanInputStored {
  const known = new Map(Object.entries(stored.index).map(([id, v]) => [v.key as string, id]));
  const llm = { ...stored.llm };
  let added: PlanInputStored["index"] = {};
  if (req.types.length) {
    const sel = selectWishPlaces(loaded.activities, [{ types: req.types, open: false }]);
    const acts = activitiesInput(sel, { lang: a.lang, known, startN: maxId(stored.index, "a"), label: FEEDBACK_WISH });
    if (acts.block) {
      const prev = llm.activities ?? { places: [], wishes: [] };
      llm.activities = { places: [...prev.places, ...acts.block.places], wishes: [...prev.wishes, ...acts.block.wishes] };
      added = { ...added, ...acts.index };
      for (const [id, e] of Object.entries(acts.index)) known.set(e.key, id);
    }
  }
  if (req.restaurants && loaded.restaurants) {
    const cuisine = mergeCuisine(stored.llm.restaurants?.ask, req.restaurants.cuisine);
    const rest = restaurantsInput(loaded.restaurants, {
      cuisine,
      countryCode: a.countryCode,
      known,
      startN: maxId(stored.index, "r"),
      near: req.restaurants.near?.id,
    });
    if (rest.block) {
      if (req.restaurants.near) llm.restaurantsNear = rest.block;
      else llm.restaurants = rest.block;
      added = { ...added, ...rest.index };
    }
  }
  return { ...stored, llm: JSON.parse(JSON.stringify(llm)) as PlanInputStored["llm"], index: { ...stored.index, ...added } };
}
