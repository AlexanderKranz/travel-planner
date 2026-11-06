import { z } from "zod";
import { MAX_RADIUS_KM } from "@/lib/facts/interest-sources";

/**
 * Activity catalogue (spec activities-and-restaurants section 1): concrete things to book, separate from
 * INTEREST_KEYS. Groups are by place (indoor / outdoor / going_out), not by time of day (spec D7). Every OSM filter
 * was checked on taginfo (https://taginfo.openstreetmap.org, 2026-11-06, global object counts in the comments) and
 * the Geoapify categories against https://apidocs.geoapify.com/docs/places/ (2026-11-06). Types listed in the spec
 * but dropped because their tag is rare:
 * - high_ropes (`sport=ropes_course`, 15 objects worldwide) and laser_tag (`sport=laser_tag`, 480): they would
 *   almost always answer "nothing nearby" for a reason that has nothing to do with the city.
 * Kept on purpose despite being rare: footgolf (`sport=footgolf`, 11 objects). A purpose can name it explicitly, and
 * the type must exist so the plan can say "no footgolf found nearby in OpenStreetMap" (spec D6).
 * Ambiguous tag narrowed: `sport=climbing` (90k, mostly single routes and boulders) is only used as
 * `climbing_hall` (sports_centre or indoor=yes) and `climbing` (`climbing=crag`, 14k).
 */
export const ACTIVITY_GROUPS = ["indoor", "outdoor", "going_out"] as const;
export const ActivityGroup = z.enum(ACTIVITY_GROUPS);
export type ActivityGroup = z.infer<typeof ActivityGroup>;

export const ACTIVITY_TYPES = [
  "escape_game",
  "bowling",
  "cinema",
  "theatre",
  "karaoke",
  "climbing_hall",
  "boat_rental",
  "rowing",
  "canoe",
  "minigolf",
  "footgolf",
  "karting",
  "climbing",
  "bar",
] as const;
export const ActivityType = z.enum(ACTIVITY_TYPES);
export type ActivityType = z.infer<typeof ActivityType>;

export type ActivitySource = {
  group: ActivityGroup;
  /** Overpass filter lines (each also requires a name, see buildQuery) and the same filters applied to Geoapify results. */
  filters: readonly string[];
  /**
   * Geoapify categories, a superset of the filters. Absent = no category exists, Overpass only
   * (karaoke, climbing, rowing, canoe, karting).
   */
  geoapify?: readonly string[];
  /** Search radius for this type in km (capped at MAX_RADIUS_KM). */
  defaultRadiusKm: number;
};

/** OSM `sport` is a semicolon list (`climbing;fitness`): every sport filter matches a whole token. */
const notSlipway = `["leisure"!~"^(slipway|marina)$"]`;

export const ACTIVITY_SOURCES: Record<ActivityType, ActivitySource> = {
  escape_game: { group: "indoor", filters: [`["leisure"="escape_game"]`], geoapify: ["entertainment.escape_game"], defaultRadiusKm: 10 }, // 3.3k
  bowling: { group: "indoor", filters: [`["leisure"="bowling_alley"]`], geoapify: ["entertainment.bowling_alley"], defaultRadiusKm: 10 }, // 6.5k
  cinema: { group: "indoor", filters: [`["amenity"="cinema"]`], geoapify: ["entertainment.cinema"], defaultRadiusKm: 10 }, // 32k
  theatre: { group: "indoor", filters: [`["amenity"="theatre"]`], geoapify: ["entertainment.culture.theatre"], defaultRadiusKm: 10 }, // 54k
  karaoke: { group: "indoor", filters: [`["amenity"="karaoke_box"]`], defaultRadiusKm: 10 }, // 2.9k
  climbing_hall: { group: "indoor", filters: [`["leisure"="sports_centre"]["sport"~"(^|;)climbing(;|$)"]`, `["sport"~"(^|;)climbing(;|$)"]["indoor"="yes"]`], defaultRadiusKm: 15 }, // 5.3k + indoor
  boat_rental: { group: "outdoor", filters: [`["amenity"="boat_rental"]`], geoapify: ["rental.boat"], defaultRadiusKm: 25 }, // 6.9k
  rowing: { group: "outdoor", filters: [`["sport"~"(^|;)rowing(;|$)"]${notSlipway}`], defaultRadiusKm: 25 }, // 1.7k
  canoe: { group: "outdoor", filters: [`["sport"~"(^|;)canoe(;|$)"]${notSlipway}`], defaultRadiusKm: 25 }, // 3.1k
  minigolf: { group: "outdoor", filters: [`["leisure"="miniature_golf"]`], geoapify: ["entertainment.miniature_golf"], defaultRadiusKm: 15 }, // 11k
  footgolf: { group: "outdoor", filters: [`["sport"~"(^|;)footgolf(;|$)"]`], defaultRadiusKm: 25 }, // 11, kept on purpose (see header)
  karting: { group: "outdoor", filters: [`["sport"~"(^|;)karting(;|$)"]`], defaultRadiusKm: 25 }, // 11k
  climbing: { group: "outdoor", filters: [`["sport"~"(^|;)climbing(;|$)"]["climbing"="crag"]`], defaultRadiusKm: 25 }, // 14k
  bar: { group: "going_out", filters: [`["amenity"~"^(bar|pub|biergarten)$"]`], geoapify: ["catering.bar", "catering.pub", "catering.biergarten"], defaultRadiusKm: 3 }, // 650k
};

export const isActivityType = (s: string): s is ActivityType => (ACTIVITY_TYPES as readonly string[]).includes(s);

export const typesInGroup = (group: ActivityGroup): ActivityType[] =>
  ACTIVITY_TYPES.filter((t) => ACTIVITY_SOURCES[t].group === group);

/** Query radius of a group: the largest default radius of its types (one union query), capped at 60 km. */
export const radiusForGroup = (group: ActivityGroup): number =>
  Math.min(MAX_RADIUS_KM, Math.max(...typesInGroup(group).map((t) => ACTIVITY_SOURCES[t].defaultRadiusKm)));

/** A group's types all have a Geoapify mapping, so one Geoapify lookup would cover the whole union. */
export const groupHasGeoapify = (group: ActivityGroup): boolean =>
  typesInGroup(group).every((t) => ACTIVITY_SOURCES[t].geoapify !== undefined);

/**
 * Group a found place counts in: its type's group, except that a place tagged `indoor=yes` counts as indoor even
 * when its type is outdoor (indoor minigolf).
 */
export function placeGroup(type: ActivityType, tags: Record<string, string>): ActivityGroup {
  const g = ACTIVITY_SOURCES[type].group;
  return g === "outdoor" && tags.indoor === "yes" ? "indoor" : g;
}

/** One purpose wish as Haiku tags it (spec section 2). */
export type ActivityWish = { types: readonly ActivityType[]; open: boolean; group?: ActivityGroup };

/**
 * Types to look up for one wish: its own types, plus (when `open`, "only an idea") every type of their group.
 * An entry without types uses its `group` when `open`; an entry without types and without a valid group is
 * dropped (empty list). With types, each type's own group is used and `group` is ignored. Catalogue order.
 */
export function expandWish(wish: ActivityWish): ActivityType[] {
  const out = new Set<ActivityType>(wish.types);
  if (wish.open) {
    const groups = new Set<ActivityGroup>(wish.types.map((t) => ACTIVITY_SOURCES[t].group));
    if (groups.size === 0 && wish.group && ActivityGroup.safeParse(wish.group).success) groups.add(wish.group);
    for (const g of groups) for (const t of typesInGroup(g)) out.add(t);
  }
  return ACTIVITY_TYPES.filter((t) => out.has(t));
}

/**
 * Groups to query for a set of wishes (one Overpass union query each, spec section 6): the group of each wish type
 * (an entry without types: its valid `group`, else nothing). All needed groups, at most three (the whole catalogue).
 */
export function groupsForWishes(wishes: readonly ActivityWish[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const w of wishes) {
    const wanted =
      w.types.length > 0 ? w.types.map((t) => ACTIVITY_SOURCES[t].group) : w.group && ActivityGroup.safeParse(w.group).success ? [w.group] : [];
    for (const g of wanted) if (!groups.includes(g)) groups.push(g);
  }
  return groups;
}
