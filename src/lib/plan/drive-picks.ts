import type { TripFacts } from "@/lib/domain/facts";
import type { TripPurpose } from "@/lib/domain/purpose";
import { interestsForTrip } from "@/lib/facts/interest-sources";
import { selectWishPlaces, wishPlacePicks } from "./activities-input";
import { selectPlaces } from "./input";

/**
 * Places that get a drive time (one ORS matrix call): the selected interest places, then the activity places of the
 * purpose wishes (they can lie up to 25 km out). Restaurants are within 2.5-5 km and get none. Pure.
 */
export function drivePicks(
  facts: TripFacts,
  purpose: Pick<TripPurpose, "guided" | "tags"> | null,
): { key: string; lat: number; lon: number }[] {
  const picks = selectPlaces(facts, interestsForTrip(purpose?.guided, purpose?.tags).keys).picks;
  const out = picks.map((p) => ({ key: p.key as string, lat: p.c.lat, lon: p.c.lon }));
  const seen = new Set(out.map((p) => p.key));
  for (const p of wishPlacePicks(selectWishPlaces(facts.activities, purpose?.tags?.activities))) {
    if (!seen.has(p.key)) out.push(p);
  }
  return out;
}
