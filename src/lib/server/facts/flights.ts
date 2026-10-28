import "server-only";
import type { Fact, FactsCtx } from "@/lib/domain/facts";
import type { FlightsFacts } from "@/lib/domain/flights";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import found from "@/lib/flights/__fixtures__/flights-fact-found.json";

/** STUB (step 0): returns the "found" fixture. integrations-dev replaces it with the real lookups; never throws. */
export async function getFlightsFacts(
  _trip: Trip,
  _a: { homeAirports: string[]; purpose: TripPurpose | null; ctx: FactsCtx; budgetMs?: number },
): Promise<Fact<FlightsFacts>> {
  return found as Fact<FlightsFacts>;
}
