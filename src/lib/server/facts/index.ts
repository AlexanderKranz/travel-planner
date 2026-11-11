import "server-only";
import type { Fact, FactsCtx, TripFacts } from "@/lib/domain/facts";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import type { TripStop } from "@/lib/domain/trip-stops";
import { referenceDates } from "@/lib/facts/trip-timing";
import { jobsForStops, jobsForTripFacts } from "@/lib/places-retry";
import { enqueuePlaceRetries } from "../place-retries";
import { resolveTripStops } from "../trip-stops";
import { getCountryFacts } from "./country";
import { getDaylightFacts } from "./daylight";
import { getFlightsFacts } from "./flights";
import { getDestinationPicture, getSharedDestinationPicture } from "./picture";
import { getTripActivityFacts } from "./activity-lookups";
import { getPlacesFacts } from "./places";
import { getStopFacts } from "./stops";
import { getSummaryFacts } from "./summary";
import { getWeatherFacts } from "./weather";

export { getDestinationPicture, getSharedDestinationPicture };
export { getCountryFacts, getDaylightFacts, getFlightsFacts, getPlacesFacts, getSummaryFacts, getWeatherFacts };

/** Flights lookups inside plan generation (spec 3). */
export const FLIGHTS_PLAN_BUDGET_MS = 20_000;

const failed: Fact<never> = { status: "unavailable", reason: "provider_error" };
const safe = <T>(p: Promise<Fact<T>>): Promise<Fact<T>> => p.catch(() => failed);

/**
 * Stops of the trip whose places are looked up too (port-places). Inline runs (Generate, patch) never query Overpass
 * over the network for them and look them up beside the destination; the warm-up (`afterDestination`) may, with the
 * time that is left once the destination is done [P7].
 */
type StopsOption = { list: readonly TripStop[]; overpass: "cache_only" | "allowed"; afterDestination?: boolean };

async function collect(
  trip: Trip,
  purpose: TripPurpose | null,
  ctx: FactsCtx,
  placesBudgetMs?: number,
  withFlights?: { homeAirports: string[] },
  stops?: StopsOption,
): Promise<TripFacts> {
  const started = Date.now();
  const stopBudget = () => (placesBudgetMs === undefined ? WARM_BUDGET_MS : Math.max(0, placesBudgetMs - (stops?.afterDestination ? Date.now() - started : 0)));
  const lookupStops = () =>
    stops?.list.length
      ? getStopFacts(trip, stops.list, purpose, ctx, { budgetMs: stopBudget(), overpass: stops.overpass }).catch(() => [])
      : Promise.resolve([]);
  const [weather, daylight, country, summary, places, flights, acts, parallelStops] = await Promise.all([
    safe(getWeatherFacts(trip, ctx)),
    safe(getDaylightFacts(trip, ctx)),
    safe(getCountryFacts(trip, ctx)),
    safe(getSummaryFacts(trip, ctx)),
    safe(getPlacesFacts(trip, purpose, ctx, { budgetMs: placesBudgetMs })),
    withFlights && trip.wantsFlights
      ? safe(getFlightsFacts(trip, { homeAirports: withFlights.homeAirports, purpose, ctx, budgetMs: FLIGHTS_PLAN_BUDGET_MS }))
      : Promise.resolve(undefined),
    // Activity groups + restaurants (activities spec): same places budget, in parallel with the interest lookups.
    getTripActivityFacts(trip, purpose, ctx, placesBudgetMs).catch(() => ({})),
    stops?.afterDestination ? Promise.resolve([]) : lookupStops(),
  ]);
  const stopFacts = stops?.afterDestination ? await lookupStops() : parallelStops;
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
    ...acts,
    ...(stopFacts.length ? { stops: stopFacts } : {}),
  };
}

/** Phase 3 snapshot input. `placesBudgetMs` caps Overpass time (groups that do not finish become no_source). Never throws. */
export function getTripFacts(
  trip: Trip,
  purpose: TripPurpose | null,
  ctx: FactsCtx,
  options: { placesBudgetMs?: number; withFlights?: { homeAirports: string[] }; stops?: readonly TripStop[] } = {},
): Promise<TripFacts> {
  return collect(trip, purpose, ctx, options.placesBudgetMs, options.withFlights, options.stops?.length ? { list: options.stops, overpass: "cache_only" } : undefined);
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
    // Confirmed stops, else stops derived from the notes (itinerary-upload [D10]); none for most trips.
    const stops = await resolveTripStops(trip);
    const [facts] = await Promise.all([
      collect(trip, purpose, ctx, options.budgetMs ?? WARM_BUDGET_MS, undefined, stops.length ? { list: stops, overpass: "allowed", afterDestination: true } : undefined),
      getDestinationPicture(trip, ctx), // fills api_cache so the share page (cache-only) can show it
    ]);
    // What still failed after this first attempt is retried in the background for at most 30 minutes.
    await enqueuePlaceRetries(jobsForTripFacts(trip, purpose, facts));
    await enqueuePlaceRetries(jobsForStops(facts.stops ?? []));
  } catch {
    // warming is best effort
  }
}
