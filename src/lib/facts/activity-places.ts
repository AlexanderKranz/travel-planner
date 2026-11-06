import { z } from "zod";
import { ACTIVITY_SOURCES, ActivityGroup, ActivityType, isOpenAirBath, placeGroup, typesInGroup } from "@/lib/facts/activity-types";
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
): ActivityPlace[] {
  const tagsOf = new Map(elements.map((e) => [`${e.type}/${e.id}`, e.tags]));
  const idOf = (c: { osmType: string; osmId: number }) => `${c.osmType}/${c.osmId}`;
  const perType: { type: ActivityType; list: ReturnType<typeof rankCandidates> }[] = [];
  const typesOf = new Map<string, ActivityType[]>();
  for (const type of typesInGroup(group)) {
    const { filters, defaultRadiusKm } = ACTIVITY_SOURCES[type];
    const mine = elements.filter((e) => filters.some((f) => matchesFilter(e.tags, f)));
    const ranked = rankCandidates(mine, filters, anchor, undefined, defaultRadiusKm);
    const list = (type === "swimming" ? indoorPoolsFirst(ranked, tagsOf) : ranked).slice(0, MAX_PER_TYPE);
    if (!list.length) continue;
    perType.push({ type, list });
    for (const c of list) typesOf.set(idOf(c), [...(typesOf.get(idOf(c)) ?? []), type]);
  }
  const out: ActivityPlace[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < MAX_PER_TYPE && out.length < MAX_PER_GROUP; i++) {
    for (const { list } of perType) {
      const c = list[i];
      if (!c || seen.has(idOf(c)) || out.length >= MAX_PER_GROUP) continue;
      seen.add(idOf(c));
      const types = typesOf.get(idOf(c))!;
      out.push({ ...c, types, group: placeGroup(types[0], tagsOf.get(idOf(c)) ?? {}) });
    }
  }
  return out;
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
