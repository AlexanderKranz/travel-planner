import type { ActivityGroupLookup, CafeLookup, PlaceGroup, RestaurantLookup } from "@/lib/domain/facts";
import type { InterestKey } from "@/lib/domain/interests";
import type { NeedPlaces } from "@/lib/domain/plan";
import type { Locale } from "@/lib/domain/profile";
import { groupsForWishes, isActivityType, type ActivityGroup, type ActivityType } from "@/lib/facts/activity-types";
import { CUISINES, type CuisineWish } from "@/lib/facts/cuisine";
import { MAX_INTEREST_QUERIES, isPlaceInterest } from "@/lib/facts/interest-sources";
import { activitiesInput, cafesInput, maxId, restaurantsInput, selectWishPlaces } from "./activities-input";
import { MIN_PLACES_PER_INTEREST, interestPlace, type PlanInputStored } from "./input";

/** Label of the wish a change request adds to the input (the model links it to FEEDBACK). */
export const FEEDBACK_WISH = "FEEDBACK";

/** A validated `needPlaces`: what code loads before the second patch call (activities spec section 4). */
export type NeedPlacesRequest = {
  types: ActivityType[];
  groups: ActivityGroup[];
  restaurants?: { cuisine?: CuisineWish; near?: { id: string; lat: number; lon: number } };
  /** Cafés (addendum A2); `kids` only when the request explicitly asked for child-friendly places. */
  cafes?: { kids?: boolean; near?: { id: string; lat: number; lon: number } };
  /** Purpose interests with a place source (issue #151): loaded like the plan's interest candidates. */
  interests?: InterestKey[];
};

/** Places per interest a change request adds (the plan's minimum share per interest). */
export const NEED_INTEREST_PLACES = MIN_PLACES_PER_INTEREST;

const cuisines = (xs: readonly string[] | undefined) =>
  [...new Set((xs ?? []).map((x) => String(x).trim().toLowerCase()))].filter((x) => (CUISINES as readonly string[]).includes(x));

/**
 * Model `needPlaces` -> what to load, or null when nothing loadable is left. Unknown types and cuisines are dropped;
 * `near` must be an id of the stored input (a place with coordinates), else it is ignored and restaurants are
 * loaded around the destination point. Pure.
 */
export function resolveNeedPlaces(need: NeedPlaces | undefined, stored: PlanInputStored): NeedPlacesRequest | null {
  if (!need) return null;
  // Own keys only: a model-supplied "constructor" or "__proto__" must never resolve.
  const nearOf = (raw: string | undefined) => {
    const id = raw?.trim();
    const hit = id && Object.hasOwn(stored.index, id) ? stored.index[id] : undefined;
    return hit && id ? { near: { id, lat: hit.place.lat, lon: hit.place.lon } } : {};
  };
  const types = [...new Set((need.types ?? []).map((t) => String(t).trim()).filter(isActivityType))];
  const groups = groupsForWishes([{ types, open: false }]);
  let restaurants: NeedPlacesRequest["restaurants"];
  if (need.restaurants) {
    const c = need.restaurants.cuisine;
    const include = cuisines(c?.include);
    const exclude = cuisines(c?.exclude);
    const kids = c?.kids === true;
    const cuisine =
      c && (c.local !== undefined || include.length || exclude.length || kids)
        ? { ...(c.local !== undefined ? { local: c.local } : {}), include, exclude, ...(kids ? { kids } : {}) }
        : undefined;
    restaurants = { ...(cuisine ? { cuisine } : {}), ...nearOf(need.restaurants.near) };
  }
  const cafes: NeedPlacesRequest["cafes"] = need.cafes ? { ...(need.cafes.kids === true ? { kids: true } : {}), ...nearOf(need.cafes.near) } : undefined;
  // Only interests with a place source, at most MAX_INTEREST_QUERIES lookups (like the plan's own interests).
  const interests = [...new Set((need.interests ?? []).map((k) => String(k).trim()).filter(isPlaceInterest))].slice(0, MAX_INTEREST_QUERIES);
  if (!types.length && !restaurants && !cafes && !interests.length) return null;
  return { types, groups, ...(restaurants ? { restaurants } : {}), ...(cafes ? { cafes } : {}), ...(interests.length ? { interests } : {}) };
}

/**
 * The change request's cuisine on top of the earlier wish: `local`, `include` and `exclude` the request leaves
 * unset are kept ("and no pizza" keeps "local food"). Pure.
 */
export function mergeCuisine(
  prev: { local?: boolean; include?: string[]; exclude?: string[]; kids?: boolean } | undefined,
  next: CuisineWish | undefined,
): CuisineWish | undefined {
  if (!prev && !next) return undefined;
  const kids = next?.kids ?? prev?.kids === true;
  return {
    local: next?.local ?? prev?.local === true,
    include: next?.include?.length ? [...next.include] : [...(prev?.include ?? [])],
    exclude: next?.exclude?.length ? [...next.exclude] : [...(prev?.exclude ?? [])],
    ...(kids ? { kids } : {}),
  };
}

/**
 * Stored input + loaded places -> the input of the new version (pure). Activity places of the requested types are
 * added as one more wish labelled FEEDBACK_WISH. Restaurants around the destination replace the RESTAURANTS block
 * (the request's cuisine merged with the old block's wish, `mergeCuisine`); restaurants around a
 * place go into `restaurantsNear`. Cafés replace the CAFES block (around `near` when given; `kids` from the request
 * or the earlier block or restaurant wish). Every old index entry stays, so refs of untouched days remain valid.
 */
export function extendInput(
  stored: PlanInputStored,
  req: NeedPlacesRequest,
  loaded: { activities: ActivityGroupLookup[]; restaurants?: RestaurantLookup; cafes?: CafeLookup; interests?: PlaceGroup[] },
  a: { lang: Locale; countryCode?: string | null },
): PlanInputStored {
  const known = new Map(Object.entries(stored.index).map(([id, v]) => [v.key as string, id]));
  const llm = { ...stored.llm };
  let added: PlanInputStored["index"] = {};
  if (req.interests?.length) {
    const x = interestsInput(stored, req.interests, loaded.interests ?? [], { lang: a.lang, known });
    llm.places = x.places;
    llm.noSource = x.noSource;
    added = { ...added, ...x.index };
  }
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
      for (const [id, e] of Object.entries(rest.index)) known.set(e.key, id);
    }
  }
  if (req.cafes && loaded.cafes) {
    const kids = req.cafes.kids === true || stored.llm.cafes?.kids === true || llm.restaurants?.ask?.kids === true;
    const cafes = cafesInput(loaded.cafes, { kids, known, startN: maxId(stored.index, "c"), near: req.cafes.near?.id });
    if (cafes.block) {
      llm.cafes = cafes.block;
      added = { ...added, ...cafes.index };
    }
  }
  return { ...stored, llm: JSON.parse(JSON.stringify(llm)) as PlanInputStored["llm"], index: { ...stored.index, ...added } };
}

/**
 * Interest places a change request loaded (issue #151) -> new `places` rows (ids after the highest p id, `i` = the
 * interest) and index entries, up to NEED_INTEREST_PLACES per interest, skipping places already in the input (they
 * keep their id and still count as places of the interest). An interest that found nothing (or has no group, e.g. a
 * free-text destination) goes to noSource; one with places leaves it. Mutates `known`. Pure otherwise.
 */
function interestsInput(
  stored: PlanInputStored,
  keys: readonly InterestKey[],
  groups: readonly PlaceGroup[],
  a: { lang: Locale; known: Map<string, string> },
): { places: PlanInputStored["llm"]["places"]; noSource: string[]; index: PlanInputStored["index"] } {
  const places = [...(stored.llm.places ?? [])];
  const noSource = [...(stored.llm.noSource ?? [])];
  const index: PlanInputStored["index"] = {};
  let n = maxId(stored.index, "p");
  for (const interest of keys) {
    const g = groups.find((x) => x.interest === interest);
    let count = 0;
    // A candidate already in the input (another interest, the activities block, or an earlier key of this call) is
    // a verified place for this interest too: the interest must not land in noSource ("not covered" would be false).
    let alreadyListed = false;
    if (g?.status === "ok") {
      for (const c of g.candidates) {
        if (count >= NEED_INTEREST_PLACES) break;
        const key = `${c.osmType}/${c.osmId}` as PlanInputStored["index"][string]["key"];
        if (a.known.has(key)) {
          alreadyListed = true;
          continue;
        }
        const id = `p${++n}`;
        const { row, entry } = interestPlace({ interest, c, key, fetchedAt: g.fetchedAt }, id, { lang: a.lang });
        places.push(row);
        index[id] = entry;
        a.known.set(key, id);
        count += 1;
      }
    }
    const listed = count > 0 || alreadyListed || places.some((p) => p.i === interest);
    const at = noSource.indexOf(interest);
    if (listed && at >= 0) noSource.splice(at, 1);
    if (!listed && at < 0) noSource.push(interest);
  }
  return { places, noSource, index };
}
