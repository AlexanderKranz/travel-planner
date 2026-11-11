import type { ActivityGroupLookup, ActivityTypeStatus, CafeLookup, LookupStatus, RestaurantLookup } from "@/lib/domain/facts";
import type { ActivityWishTag, OsmKey, PlanPlace } from "@/lib/domain/plan";
import type { Locale } from "@/lib/domain/profile";
import type { ActivityPlace } from "@/lib/facts/activity-places";
import { ACTIVITY_SOURCES, expandWish, type ActivityGroup, type ActivityType } from "@/lib/facts/activity-types";
import { selectCafes, selectRestaurants, type CuisineWish, type Restaurant } from "@/lib/facts/cuisine";

/**
 * LLM input blocks for purpose activity wishes and restaurants (activities spec section 5). Pure.
 * Ids: activity places `a1..`, restaurants `r1..`, cafés `c1..`; a place that is already in `places` keeps its `p` id.
 */
export type ActivitiesInput = {
  /** g = effective group (an outdoor type tagged indoor=yes counts as indoor). km straight line, min drive minutes. */
  /** t = every catalogue type the place matches (`sport=rowing;canoe`). */
  places: { id: string; name: string; t: ActivityType[]; g: ActivityGroup; km: number; min?: number }[];
  /** Per wish: w = what was asked for, open = only an idea, suggest options; per type its lookup status and place ids. */
  wishes: { w?: string; open?: true; types: { t: ActivityType; s: TypeStatus; ids?: string[] }[] }[];
};
/** Per-type status: a lookup status, or `cut` = no place of this type in a result cut off at the query cap. */
export type TypeStatus = Exclude<ActivityTypeStatus, "unrequested">;

/**
 * What one type of a group lookup really got (Addendum 3): the stored `typeStatus` when present, else derived from
 * the group as before the per-source split (error/skipped as the group; ok/empty: found, cut when truncated, else
 * empty). No lookup = skipped.
 */
export function lookupTypeStatus(look: ActivityGroupLookup | undefined, t: ActivityType): ActivityTypeStatus {
  if (!look) return "skipped";
  const own = look.typeStatus?.[t];
  if (own) return own;
  if (look.status === "error" || look.status === "skipped") return look.status;
  return look.places.some((p) => p.types.includes(t)) ? "ok" : look.truncated ? "cut" : "empty";
}
export type RestaurantsInput = {
  s: LookupStatus;
  /** The cuisine wish the list was filtered with. */
  ask?: { local?: true; include?: string[]; exclude?: string[]; kids?: true };
  /** Id of the place the list is around (change requests); absent = the destination point. */
  near?: string;
  /** Fewer than 3 restaurants match the wish. */
  tooFew?: true;
  /**
   * c = OSM cuisine values, km = straight line from the destination point (or `near`), k = kids-tagged; k is sent
   * only with `ask.kids` (addendum A4: the model never sees, or claims, child-friendliness otherwise).
   */
  list: RestaurantsInputEntry[];
};
type RestaurantsInputEntry = { id: string; name: string; c?: string; km: number; k?: true };
/** Cafés (addendum A2), loaded only when asked for. `kids` = child-friendly places were asked for; k as above. */
export type CafesInput = { s: LookupStatus; near?: string; kids?: true; list: RestaurantsInputEntry[] };

export type IndexEntry = { key: OsmKey; place: PlanPlace };
type DriveByKey = { byKey: Record<string, { min: number; km: number }>; fetchedAt: string } | null | undefined;

/** Places per named type of a wish, and per type an `open` wish adds from the same group. */
export const MAX_PER_NAMED_TYPE = 4;
export const MAX_PER_EXTRA_TYPE = 2;

const round1 = (n: number) => Math.round(n * 10) / 10;
const keyOf = (p: { osmType: string; osmId: number }) => `${p.osmType}/${p.osmId}` as OsmKey;

export function safeUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const defined = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
};

export type WishSelection = {
  wish: ActivityWishTag;
  types: { t: ActivityType; s: TypeStatus; places: { p: ActivityPlace; fetchedAt: string }[] }[];
};

/**
 * Per wish and type: lookup status and places (named types MAX_PER_NAMED_TYPE; the other types an open wish adds
 * MAX_PER_EXTRA_TYPE, and only when they have places). A place matching several types is listed under the first
 * of them in the wish; a type whose only places are already listed under another type reuses them (status ok,
 * never a false `empty`). The status is decided per type (`lookupTypeStatus`, Addendum 3): in a `partial` group the
 * working part's types keep their places and status, the failed part's types are `error`/`skipped`. `empty` only
 * for a type whose own source answered completely.
 */
export function selectWishPlaces(lookups: readonly ActivityGroupLookup[] | undefined, wishes: readonly ActivityWishTag[] | undefined): WishSelection[] {
  return (wishes ?? []).flatMap((wish) => {
    const types = expandWish(wish);
    if (!types.length) return [];
    const out: WishSelection["types"] = [];
    const seen = new Set<string>();
    for (const t of types) {
      const named = wish.types.includes(t);
      const look = lookups?.find((g) => g.group === ACTIVITY_SOURCES[t].group);
      const cap = named ? MAX_PER_NAMED_TYPE : MAX_PER_EXTRA_TYPE;
      const ofType = (look?.places ?? []).filter((p) => p.types.includes(t));
      const fresh = ofType.filter((p) => !seen.has(keyOf(p)));
      const places = (fresh.length ? fresh : ofType).slice(0, cap).map((p) => ({ p, fetchedAt: look?.fetchedAt ?? "" }));
      for (const { p } of places) seen.add(keyOf(p));
      // ok without places here = dropped by the group cap: unknown, never "nothing found". A wished type the lookup
      // did not request (should not happen) is reported as not checked.
      const own = lookupTypeStatus(look, t);
      const s: TypeStatus = places.length ? "ok" : own === "ok" ? "cut" : own === "unrequested" ? "skipped" : own;
      // Types an open wish only adds as options are listed when they have places: the plan reports a missing type
      // only when the travellers named it (live eval: "Karaoke: nothing found" for a wish that never named karaoke).
      // They are best effort (QA #139): failed or skipped, they are simply not offered. Only a wish that names no
      // type keeps its failed or skipped types, so the plan can say they could not be checked.
      const groupOnly = wish.types.length === 0;
      if (!named && !places.length && (!groupOnly || s === "empty" || s === "cut")) continue;
      out.push({ t, s, places });
    }
    return out.length ? [{ wish, types: out }] : [];
  });
}

/** Unique activity places of a selection (for the drive-time request). */
export function wishPlacePicks(sel: readonly WishSelection[]): { key: OsmKey; lat: number; lon: number }[] {
  const out = new Map<OsmKey, { key: OsmKey; lat: number; lon: number }>();
  for (const w of sel) for (const t of w.types) for (const { p } of t.places) out.set(keyOf(p), { key: keyOf(p), lat: p.lat, lon: p.lon });
  return [...out.values()];
}

/** Highest number used with `prefix` in an index ("a3" -> 3). */
export function maxId(index: Record<string, unknown>, prefix: string): number {
  let n = 0;
  for (const id of Object.keys(index)) if (id.startsWith(prefix)) n = Math.max(n, Number(id.slice(prefix.length)) || 0);
  return n;
}

/**
 * Wish selection -> ACTIVITIES block + index entries. `known` maps OSM keys already in the index to their id
 * (interest places, earlier activity places), so a place is never listed twice.
 */
export function activitiesInput(
  sel: readonly WishSelection[],
  a: { lang: Locale; drive?: DriveByKey; known: Map<string, string>; startN: number; label?: string },
): { block?: ActivitiesInput; index: Record<string, IndexEntry> } {
  if (!sel.length) return { index: {} };
  const places: ActivitiesInput["places"] = [];
  const index: Record<string, IndexEntry> = {};
  const known = new Map(a.known);
  let n = a.startN;
  const idFor = (p: ActivityPlace, fetchedAt: string): string => {
    const key = keyOf(p);
    const hit = known.get(key);
    if (hit) return hit;
    const id = `a${++n}`;
    known.set(key, id);
    const name = p.names[a.lang] ?? p.name;
    const d = a.drive?.byKey[key];
    places.push(defined({ id, name, t: [...p.types], g: p.group, km: round1(p.distanceKm), min: d?.min }));
    index[id] = {
      key,
      place: defined({
        name,
        category: p.category,
        lat: p.lat,
        lon: p.lon,
        distanceKm: round1(p.distanceKm),
        osmUrl: p.osmUrl,
        wikipedia: p.wikipedia,
        website: safeUrl(p.website),
        source: "osm" as const,
        fetchedAt,
        drive: d && a.drive ? { min: d.min, km: d.km, source: "openrouteservice" as const, fetchedAt: a.drive.fetchedAt } : undefined,
      }),
    };
    return id;
  };
  const wishes: ActivitiesInput["wishes"] = sel.map(({ wish, types }) =>
    defined({
      w: a.label ?? wish.label,
      open: wish.open ? (true as const) : undefined,
      types: types.map(({ t, s, places: ps }) => {
        const ids = ps.map(({ p, fetchedAt }) => idFor(p, fetchedAt));
        return ids.length ? { t, s, ids } : { t, s };
      }),
    }),
  );
  return { block: { places, wishes }, index };
}

/**
 * Restaurant lookup -> RESTAURANTS block + index entries (spec section 3): cuisine filter and ranking in
 * `selectRestaurants`, at most 12. `tooFew` only for a lookup that worked.
 */
export function restaurantsInput(
  look: RestaurantLookup | undefined,
  a: { cuisine?: CuisineWish | null; countryCode?: string | null; known: Map<string, string>; startN: number; near?: string; limit?: number },
): { block?: RestaurantsInput; index: Record<string, IndexEntry> } {
  if (!look) return { index: {} };
  const index: Record<string, IndexEntry> = {};
  const c = a.cuisine;
  const kids = c?.kids === true;
  const ask =
    c && (c.local || c.include?.length || c.exclude?.length || kids)
      ? defined({
          local: c.local ? (true as const) : undefined,
          include: c.include?.length ? [...c.include] : undefined,
          exclude: c.exclude?.length ? [...c.exclude] : undefined,
          kids: kids ? (true as const) : undefined,
        })
      : undefined;
  const block: RestaurantsInput = defined({ s: look.status, ask, near: a.near, list: [] as RestaurantsInput["list"] });
  if (look.status !== "ok") return { block, index };
  const sel = selectRestaurants(look.restaurants, c, a.countryCode);
  // Restaurants exist but fewer than 3 match the wish: `ok` + tooFew, never `empty` (that means none nearby at all).
  if (sel.tooFew) block.tooFew = true;
  let n = a.startN;
  for (const r of a.limit ? sel.restaurants.slice(0, a.limit) : sel.restaurants) {
    const key = keyOf(r);
    const id = a.known.get(key) ?? `r${++n}`;
    block.list.push(entry(id, r, kids));
    if (!a.known.has(key)) index[id] = { key, place: restaurantPlace(r, look.fetchedAt ?? "") };
  }
  return { block, index };
}

const entry = (id: string, r: Restaurant, kids: boolean): RestaurantsInputEntry =>
  defined({ id, name: r.name, c: r.cuisines.length ? r.cuisines.join(";") : undefined, km: round1(r.distanceKm), k: kids && r.kidsTagged ? (true as const) : undefined });

/**
 * Café lookup -> CAFES block + index entries (addendum A2): ranking in `selectCafes` (kids-tagged first only with
 * `kids`), at most 6, ids `c1..`. Validated through the shared index like restaurants.
 */
export function cafesInput(
  look: CafeLookup | undefined,
  a: { kids?: boolean; known: Map<string, string>; startN: number; near?: string; limit?: number },
): { block?: CafesInput; index: Record<string, IndexEntry> } {
  if (!look) return { index: {} };
  const kids = a.kids === true;
  const block: CafesInput = defined({ s: look.status, near: a.near, kids: kids ? (true as const) : undefined, list: [] as CafesInput["list"] });
  const index: Record<string, IndexEntry> = {};
  if (look.status !== "ok") return { block, index };
  let n = a.startN;
  for (const r of selectCafes(look.cafes, { kids }).cafes.slice(0, a.limit ?? Infinity)) {
    const key = keyOf(r);
    const id = a.known.get(key) ?? `c${++n}`;
    block.list.push(entry(id, r, kids));
    if (!a.known.has(key)) index[id] = { key, place: restaurantPlace(r, look.fetchedAt ?? "", "amenity=cafe") };
  }
  return { block, index };
}

function restaurantPlace(r: Restaurant, fetchedAt: string, category = "amenity=restaurant"): PlanPlace {
  return defined({
    name: r.name,
    category,
    lat: r.lat,
    lon: r.lon,
    distanceKm: round1(r.distanceKm),
    osmUrl: r.osmUrl,
    website: safeUrl(r.website),
    source: "osm" as const,
    fetchedAt,
  });
}
