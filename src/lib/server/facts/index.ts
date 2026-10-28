import "server-only";
import type { Fact, FactsCtx, TripFacts } from "@/lib/domain/facts";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import { referenceDates } from "@/lib/facts/trip-timing";
import { getCountryFacts } from "./country";
import { getDaylightFacts } from "./daylight";
import { getPlacesFacts } from "./places";
import { getSummaryFacts } from "./summary";
import { getWeatherFacts } from "./weather";

export { getCountryFacts, getDaylightFacts, getPlacesFacts, getSummaryFacts, getWeatherFacts };

const failed: Fact<never> = { status: "unavailable", reason: "provider_error" };
const safe = <T>(p: Promise<Fact<T>>): Promise<Fact<T>> => p.catch(() => failed);

async function collect(
  trip: Trip,
  purpose: TripPurpose | null,
  ctx: FactsCtx,
  placesBudgetMs?: number,
): Promise<TripFacts> {
  const [weather, daylight, country, summary, places] = await Promise.all([
    safe(getWeatherFacts(trip, ctx)),
    safe(getDaylightFacts(trip, ctx)),
    safe(getCountryFacts(trip, ctx)),
    safe(getSummaryFacts(trip, ctx)),
    safe(getPlacesFacts(trip, purpose, ctx, { budgetMs: placesBudgetMs })),
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
  };
}

/** Phase 3 snapshot input. Never throws. */
export function getTripFacts(trip: Trip, purpose: TripPurpose | null, ctx: FactsCtx): Promise<TripFacts> {
  return collect(trip, purpose, ctx);
}

/** Fills the cache in the background (after()). No Overpass time budget. Never throws. */
export async function warmTripFacts(trip: Trip, purpose: TripPurpose | null, ctx: FactsCtx): Promise<void> {
  try {
    await collect(trip, purpose, ctx, Number.POSITIVE_INFINITY);
  } catch {
    // warming is best effort
  }
}
