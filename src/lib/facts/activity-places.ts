import { z } from "zod";
import { ACTIVITY_SOURCES, ACTIVITY_TYPES, ActivityGroup, ActivityType, isOpenAirBath, placeGroup, typesInGroup } from "@/lib/facts/activity-types";
import { matchesFilter, rankCandidates } from "@/lib/facts/places";
import type { RawOsmElement } from "@/lib/integrations/overpass";

/** Places kept per type, and per group: about 16 activity places per generation (spec section 6). */
export const MAX_PER_TYPE = 6;
export const MAX_PER_GROUP = 16;

export const activityPlaceSchema = z.object({
  /** Every catalogue type of the group the place matches (`sport=rowing;canoe` = rowing and canoe), catalogue order. */
  types: z.array(ActivityType).min(1),
  /** Effective group: `indoor` for an outdoor type tagged indoor=yes (indoor minigolf). */
  group: ActivityGroup,
  osmType: z.enum(["node", "way", "relation"]),
  osmId: z.number(),
  name: z.string(),
  names: z.object({ de: z.string().optional(), en: z.string().optional() }),
  category: z.string(),
  lat: z.number(),
  lon: z.number(),
  distanceKm: z.number(),
  wikidata: z.string().optional(),
  wikipedia: z.string().optional(),
  website: z.string().optional(),
  osmUrl: z.string(),
});
export type ActivityPlace = z.infer<typeof activityPlaceSchema>;
export const activityPlacesSchema = z.array(activityPlaceSchema);

/**
 * Elements of one group's union query -> places with the catalogue types they match. A place counts for every
 * type whose filter it matches, so a canoe wish finds `sport=rowing;canoe`. Per type: its own radius and at most
 * MAX_PER_TYPE places (nearest, well-documented first, see rankCandidates). The group list takes the types
 * round-robin, up to MAX_PER_GROUP distinct places, so one dense type (theatres) cannot crowd the others out. Pure.
 */
export function activityPlacesForGroup(
  group: ActivityGroup,
  elements: readonly RawOsmElement[],
  anchor: { lat: number; lon: number },
  /** Only these types of the group (one source part of a split lookup); default every type of the group. */
  only: readonly ActivityType[] = typesInGroup(group),
): ActivityPlace[] {
  const tagsOf = new Map(elements.map((e) => [`${e.type}/${e.id}`, e.tags]));
  const idOf = (c: { osmType: string; osmId: number }) => `${c.osmType}/${c.osmId}`;
  const perType: { type: ActivityType; list: ReturnType<typeof rankCandidates> }[] = [];
  const typesOf = new Map<string, ActivityType[]>();
  for (const type of typesInGroup(group).filter((t) => only.includes(t))) {
    const { filters, defaultRadiusKm } = ACTIVITY_SOURCES[type];
    const mine = elements.filter((e) => filters.some((f) => matchesFilter(e.tags, f)));
    const ranked = rankCandidates(mine, filters, anchor, undefined, defaultRadiusKm);
    const list = (type === "swimming" ? indoorPoolsFirst(ranked, tagsOf) : ranked).slice(0, MAX_PER_TYPE);
    if (!list.length) continue;
    perType.push({ type, list });
    for (const c of list) typesOf.set(idOf(c), [...(typesOf.get(idOf(c)) ?? []), type]);
  }
  return roundRobin(perType.map(({ list }) => list)).map((c) => {
    const types = typesOf.get(idOf(c))!;
    return { ...c, types, group: placeGroup(types[0], tagsOf.get(idOf(c)) ?? {}) };
  });
}

/** Takes the lists round-robin (best of each first), distinct places, at most MAX_PER_GROUP. */
function roundRobin<T extends { osmType: string; osmId: number }>(lists: readonly (readonly T[])[]): T[] {
  const idOf = (c: T) => `${c.osmType}/${c.osmId}`;
  const out: T[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < MAX_PER_TYPE && out.length < MAX_PER_GROUP; i++) {
    for (const list of lists) {
      const c = list[i];
      if (!c || seen.has(idOf(c)) || out.length >= MAX_PER_GROUP) continue;
      seen.add(idOf(c));
      out.push(c);
    }
  }
  return out;
}

/**
 * Places of the two source parts of one group (Geoapify types, Overpass-only types) -> one list. A place found by
 * both parts keeps the union of its types (catalogue order). Per type the places keep their order from the part
 * lists; the result is round-robin over the types again, so a type served by one part cannot be crowded out by the
 * other, at most MAX_PER_TYPE per type and MAX_PER_GROUP in total. Pure.
 */
export function mergeActivityPlaces(group: ActivityGroup, parts: readonly (readonly ActivityPlace[])[]): ActivityPlace[] {
  const idOf = (c: { osmType: string; osmId: number }) => `${c.osmType}/${c.osmId}`;
  const byId = new Map<string, ActivityPlace>();
  for (const p of parts.flat()) {
    const prev = byId.get(idOf(p));
    byId.set(idOf(p), prev ? { ...prev, types: ACTIVITY_TYPES.filter((t) => prev.types.includes(t) || p.types.includes(t)) } : p);
  }
  const lists = typesInGroup(group).map((t) => [...byId.values()].filter((p) => p.types.includes(t)));
  return roundRobin(lists);
}

/** Open-air pools kept per swimming list: a winter "Hallenbad" wish must not see only Freibäder (QA #137). */
export const MAX_OPEN_AIR_POOLS = 2;

/**
 * Swimming candidates classified before the per-type cut: indoor pools first (rank order kept), then at most
 * MAX_OPEN_AIR_POOLS open-air ones (`isOpenAirBath`). A list with only open-air pools keeps those (g = outdoor
 * tells the model they are for warm weather).
 */
function indoorPoolsFirst<C extends { osmType: string; osmId: number }>(ranked: readonly C[], tagsOf: Map<string, Record<string, string>>): C[] {
  const open = (c: C) => isOpenAirBath(tagsOf.get(`${c.osmType}/${c.osmId}`) ?? {});
  return [...ranked.filter((c) => !open(c)), ...ranked.filter(open).slice(0, MAX_OPEN_AIR_POOLS)];
}
