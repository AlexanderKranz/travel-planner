import type { TourInput } from "@/lib/domain/tour";

/**
 * Parts of the default tour title ("Wien · 5 Orte", spec 1 [T2]). No UI strings here (ground rule 5): the UI formats
 * them with `tours.defaultTitle` from `messages/*.json` (city may be null when the tour has no city).
 */
export function defaultTitleParts(i: Pick<TourInput, "city" | "places">): { city: string | null; count: number } {
  return { city: i.city?.name ?? null, count: i.places.length };
}

/** The user's title when set, else null (then the UI uses `defaultTitleParts`). */
export function ownTitle(i: Pick<TourInput, "title">): string | null {
  return i.title?.trim() || null;
}
