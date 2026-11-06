import type { ActivityGroupLookup, LookupStatus, RestaurantLookup } from "@/lib/domain/facts";
import type { ActivityWishTag, OsmKey, PlanPlace } from "@/lib/domain/plan";
import type { Locale } from "@/lib/domain/profile";
import type { ActivityPlace } from "@/lib/facts/activity-places";
import { ACTIVITY_SOURCES, expandWish, type ActivityGroup, type ActivityType } from "@/lib/facts/activity-types";
import { selectRestaurants, type CuisineWish, type Restaurant } from "@/lib/facts/cuisine";

/**
 * LLM input blocks for purpose activity wishes and restaurants (activities spec section 5). Pure.
 * Ids: activity places `a1..`, restaurants `r1..`; a place that is already in `places` keeps its `p` id.
 */
export type ActivitiesInput = {
  /** g = effective group (an outdoor type tagged indoor=yes counts as indoor). km straight line, min drive minutes. */
  places: { id: string; name: string; t: ActivityType; g: ActivityGroup; km: number; min?: number }[];
  /** Per wish: w = what was asked for, open = only an idea, suggest options; per type its lookup status and place ids. */
  wishes: { w?: string; open?: true; types: { t: ActivityType; s: LookupStatus; ids?: string[] }[] }[];
};
export type RestaurantsInput = {
  s: LookupStatus;
  /** The cuisine wish the list was filtered with. */
  ask?: { local?: true; include?: string[]; exclude?: string[] };
  /** Id of the place the list is around (change requests); absent = the destination point. */
  near?: string;
  /** Fewer than 3 restaurants match the wish. */
  tooFew?: true;
  /** c = OSM cuisine values, km = straight line from the destination point (or `near`). */
  list: { id: string; name: string; c?: string; km: number }[];
};

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
  types: { t: ActivityType; s: LookupStatus; places: { p: ActivityPlace; fetchedAt: string }[] }[];
};

/**
 * Per wish and type: lookup status and places (named types MAX_PER_NAMED_TYPE; the other types an open wish adds
 * MAX_PER_EXTRA_TYPE, and only when they have places). A named type whose group was not looked up is `skipped`; a
 * named type without places in a group that loaded is `empty`.
 */
export function selectWishPlaces(lookups: readonly ActivityGroupLookup[] | undefined, wishes: readonly ActivityWishTag[] | undefined): WishSelection[] {
  return (wishes ?? []).flatMap((wish) => {
    const types = expandWish(wish);
    if (!types.length) return [];
    const out: WishSelection["types"] = [];
    for (const t of types) {
      const named = wish.types.includes(t);
      const look = lookups?.find((g) => g.group === ACTIVITY_SOURCES[t].group);
      const places = (look?.places ?? [])
        .filter((p) => p.type === t)
        .slice(0, named ? MAX_PER_NAMED_TYPE : MAX_PER_EXTRA_TYPE)
        .map((p) => ({ p, fetchedAt: look?.fetchedAt ?? "" }));
      // Types an open wish only adds as options are listed when they have places: the plan reports a missing type
      // only when the travellers named it (live eval: "Karaoke: nothing found" for a wish that never named karaoke).
      // A failed or skipped group stays visible, so the plan can say it could not be checked.
      if (!named && !places.length && (look?.status === "ok" || look?.status === "empty")) continue;
      const s: LookupStatus = !look ? "skipped" : look.status === "ok" || look.status === "empty" ? (places.length ? "ok" : "empty") : look.status;
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
    places.push(defined({ id, name, t: p.type, g: p.group, km: round1(p.distanceKm), min: d?.min }));
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
  a: { cuisine?: CuisineWish | null; countryCode?: string | null; known: Map<string, string>; startN: number; near?: string },
): { block?: RestaurantsInput; index: Record<string, IndexEntry> } {
  if (!look) return { index: {} };
  const index: Record<string, IndexEntry> = {};
  const c = a.cuisine;
  const ask =
    c && (c.local || c.include?.length || c.exclude?.length)
      ? defined({ local: c.local ? (true as const) : undefined, include: c.include?.length ? [...c.include] : undefined, exclude: c.exclude?.length ? [...c.exclude] : undefined })
      : undefined;
  const block: RestaurantsInput = defined({ s: look.status, ask, near: a.near, list: [] as RestaurantsInput["list"] });
  if (look.status !== "ok") return { block, index };
  const sel = selectRestaurants(look.restaurants, c, a.countryCode);
  // Restaurants exist but fewer than 3 match the wish: `ok` + tooFew, never `empty` (that means none nearby at all).
  if (sel.tooFew) block.tooFew = true;
  let n = a.startN;
  for (const r of sel.restaurants) {
    const key = keyOf(r);
    const id = a.known.get(key) ?? `r${++n}`;
    block.list.push(defined({ id, name: r.name, c: r.cuisines.length ? r.cuisines.join(";") : undefined, km: round1(r.distanceKm) }));
    if (!a.known.has(key)) index[id] = { key, place: restaurantPlace(r, look.fetchedAt ?? "") };
  }
  return { block, index };
}

function restaurantPlace(r: Restaurant, fetchedAt: string): PlanPlace {
  return defined({
    name: r.name,
    category: "amenity=restaurant",
    lat: r.lat,
    lon: r.lon,
    distanceKm: round1(r.distanceKm),
    osmUrl: r.osmUrl,
    website: safeUrl(r.website),
    source: "osm" as const,
    fetchedAt,
  });
}
