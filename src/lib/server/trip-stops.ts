import type { Trip } from "@/lib/domain/trip";
import { tripStops, type DerivedStops, type TripStop } from "@/lib/domain/trip-stops";

/**
 * Stops derived from `trip.notes` (itinerary-upload [D10]): prefilter, then parser, then the Haiku text path on a
 * parser miss; cached per owner in `itinerary_extracts`. Returns null when there is nothing derived (no notes, fewer
 * than 2 stops, AI off, budget or limit reached, error). It never throws and never writes `trips.stops`.
 *
 * `notes` of the result must be the exact notes text the stops were derived from (`tripStops` ignores a result for
 * other notes).
 */
export type DeriveStopsFromNotes = (trip: Trip) => Promise<DerivedStops | null>;

/**
 * SEAM for the itinerary-extract work: today nothing is derived, so trips without confirmed stops resolve to none.
 * The parser/Haiku agent replaces the body (or passes its own function to `resolveTripStops`). No LLM call here.
 */
export const deriveStopsFromNotes: DeriveStopsFromNotes = async () => null;

/**
 * The stops the plan uses, resolved on the server ([D10]): confirmed `trips.stops` > stops derived from the notes >
 * none. Derivation runs only when no stops are confirmed and the trip has notes, so a trip with confirmed stops (or
 * without notes) never pays for it. A failing derivation counts as none: stops are an enhancement, never a reason
 * for a plan or a warm-up to fail.
 */
export async function resolveTripStops(
  trip: Trip,
  derive: DeriveStopsFromNotes = deriveStopsFromNotes,
): Promise<TripStop[]> {
  if (trip.stops && trip.stops.length > 0) return tripStops(trip);
  if (!trip.notes) return [];
  try {
    return tripStops(trip, await derive(trip));
  } catch {
    return [];
  }
}
