import type { TourInput } from "@/lib/domain/tour";

/**
 * Parts of the default tour title ("Wien", or "Stadttour ab Hofburg" without a city; spec 1 [T2]). No UI strings here
 * (ground rule 5): the UI formats them with `tours.defaultTitle` from `messages/*.json`.
 */
export function defaultTitleParts(i: Pick<TourInput, "city" | "places">): { city: string | null; firstPlace: string | null } {
  return { city: i.city?.name ?? null, firstPlace: i.places[0]?.name ?? null };
}

/** The user's title when set, else null (then the UI uses `defaultTitleParts`). */
export function ownTitle(i: Pick<TourInput, "title">): string | null {
  return i.title?.trim() || null;
}
