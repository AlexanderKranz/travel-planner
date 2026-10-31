import "server-only";
import type { Fact, FactsCtx, TripFacts } from "@/lib/domain/facts";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import { referenceDates } from "@/lib/facts/trip-timing";
import { getCountryFacts } from "./country";
import { getDaylightFacts } from "./daylight";
import { getFlightsFacts } from "./flights";
import { getDestinationPicture, getSharedDestinationPicture } from "./picture";
import { getPlacesFacts } from "./places";
import { getSummaryFacts } from "./summary";
import { getWeatherFacts } from "./weather";

export { getDestinationPicture, getSharedDestinationPicture };
export { getCountryFacts, getDaylightFacts, getFlightsFacts, getPlacesFacts, getSummaryFacts, getWeatherFacts };

/** Flights lookups inside plan generation (spec 3). */
export const FLIGHTS_PLAN_BUDGET_MS = 20_000;

const failed: Fact<never> = { status: "unavailable", reason: "provider_error" };
const safe = <T>(p: Promise<Fact<T>>): Promise<Fact<T>> => p.catch(() => failed);

async function collect(
  trip: Trip,
  purpose: TripPurpose | null,
  ctx: FactsCtx,
  placesBudgetMs?: number,
  withFlights?: { homeAirports: string[] },
): Promise<TripFacts> {
  const [weather, daylight, country, summary, places, flights] = await Promise.all([
    safe(getWeatherFacts(trip, ctx)),
    safe(getDaylightFacts(trip, ctx)),
    safe(getCountryFacts(trip, ctx)),
    safe(getSummaryFacts(trip, ctx)),
    safe(getPlacesFacts(trip, purpose, ctx, { budgetMs: placesBudgetMs })),
    withFlights && trip.wantsFlights
      ? safe(getFlightsFacts(trip, { homeAirports: withFlights.homeAirports, purpose, ctx, budgetMs: FLIGHTS_PLAN_BUDGET_MS }))
      : Promise.resolve(undefined),
  ]);
  return {
    tripId: trip.id,
    generatedAt: new Date().toISOString(),
    referenceDates: referenceDates(trip, ctx.today),
    weather,
    daylight,
    country,
    summary,
    places,
    ...(flights ? { flights } : {}),
  };
}

/** Phase 3 snapshot input. `placesBudgetMs` caps Overpass time (groups that do not finish become no_source). Never throws. */
export function getTripFacts(
  trip: Trip,
  purpose: TripPurpose | null,
  ctx: FactsCtx,
  options: { placesBudgetMs?: number; withFlights?: { homeAirports: string[] } } = {},
): Promise<TripFacts> {
  return collect(trip, purpose, ctx, options.placesBudgetMs, options.withFlights);
}

export const WARM_BUDGET_MS = 280_000;

/** Fills the cache in the background (after()). Overpass queries respect options.budgetMs (default 280 s). Never throws. */
export async function warmTripFacts(
  trip: Trip,
  purpose: TripPurpose | null,
  ctx: FactsCtx,
  options: { budgetMs?: number } = {},
): Promise<void> {
  try {
    await Promise.all([
      collect(trip, purpose, ctx, options.budgetMs ?? WARM_BUDGET_MS),
      getDestinationPicture(trip, ctx), // fills api_cache so the share page (cache-only) can show it
    ]);
  } catch {
    // warming is best effort
  }
}
