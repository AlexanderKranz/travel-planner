import "server-only";
import type { Trip } from "@/lib/domain/trip";
import { tripStops, type DerivedStops, type TripStop } from "@/lib/domain/trip-stops";
import { notesDeriver } from "./itinerary-notes";
import { getUserSession } from "./session";

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
 * Default deriver, on behalf of the current request's user (`getUserSession`): parser (0 tokens), then the owner's
 * cache, then Haiku on a parser miss when that user can edit the trip (the trip's `access` was computed for the same
 * viewer). Without a request scope or a session it is parser and cache only. Callers that already hold a session
 * (the warm-up in `after()`) should pass `notesDeriver(session)` from `./itinerary-notes` explicitly.
 */
export const deriveStopsFromNotes: DeriveStopsFromNotes = async (trip) => {
  let session: Awaited<ReturnType<typeof getUserSession>> = null;
  try {
    session = await getUserSession();
  } catch {
    session = null; // outside a request scope
  }
  return notesDeriver(session)(trip);
};

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
