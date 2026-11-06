import { z } from "zod";
import { ACTIVITY_SOURCES, ActivityGroup, ActivityType, placeGroup, typesInGroup } from "@/lib/facts/activity-types";
import { matchesFilter, rankCandidates } from "@/lib/facts/places";
import type { RawOsmElement } from "@/lib/integrations/overpass";

/** Places kept per type, and per group: about 16 activity places per generation (spec section 6). */
export const MAX_PER_TYPE = 6;
export const MAX_PER_GROUP = 16;

export const activityPlaceSchema = z.object({
  type: ActivityType,
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
 * Elements of one group's union query -> places tagged with their activity type. Each element is assigned to the
 * first type of the group whose filter it matches (catalogue order), every type is limited to its own radius and
 * to MAX_PER_TYPE places (nearest, well-documented first, see rankCandidates), and the group to MAX_PER_GROUP,
 * taken round-robin so one dense type (theatres) cannot crowd the others out. Pure.
 */
export function activityPlacesForGroup(
  group: ActivityGroup,
  elements: readonly RawOsmElement[],
  anchor: { lat: number; lon: number },
): ActivityPlace[] {
  const taken = new Set<string>();
  const tagsOf = new Map(elements.map((e) => [`${e.type}/${e.id}`, e.tags]));
  const perType: ActivityPlace[][] = [];
  for (const type of typesInGroup(group)) {
    const { filters, defaultRadiusKm } = ACTIVITY_SOURCES[type];
    const mine = elements.filter((e) => !taken.has(`${e.type}/${e.id}`) && filters.some((f) => matchesFilter(e.tags, f)));
    const ranked = rankCandidates(mine, filters, anchor, undefined, defaultRadiusKm).slice(0, MAX_PER_TYPE);
    for (const c of ranked) taken.add(`${c.osmType}/${c.osmId}`);
    if (ranked.length) perType.push(ranked.map((c) => ({ ...c, type, group: placeGroup(type, tagsOf.get(`${c.osmType}/${c.osmId}`) ?? {}) })));
  }
  const out: ActivityPlace[] = [];
  for (let i = 0; i < MAX_PER_TYPE && out.length < MAX_PER_GROUP; i++) {
    for (const list of perType) {
      if (list[i] && out.length < MAX_PER_GROUP) out.push(list[i]);
    }
  }
  return out;
}
