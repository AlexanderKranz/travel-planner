import "server-only";
import type {
  CountryFacts,
  DaylightFacts,
  DestinationSummary,
  Fact,
  FactsCtx,
  PlacesFacts,
  TripFacts,
  WeatherFacts,
} from "@/lib/domain/facts";
import type { Trip } from "@/lib/domain/trip";
import type { TripPurpose } from "@/lib/domain/purpose";

// TODO(phase-2): STUBS owned by integrations-dev. Each real function must never throw.
// Until implemented every fact is `unavailable` with reason `provider_error`.

const notImplemented = { status: "unavailable", reason: "provider_error" } as const;

export async function getWeatherFacts(trip: Trip, ctx: FactsCtx): Promise<Fact<WeatherFacts>> {
  void trip; void ctx;
  return notImplemented;
}

export async function getDaylightFacts(trip: Trip, ctx: FactsCtx): Promise<Fact<DaylightFacts>> {
  void trip; void ctx;
  return notImplemented;
}

export async function getCountryFacts(trip: Trip, ctx: FactsCtx): Promise<Fact<CountryFacts>> {
  void trip; void ctx;
  return notImplemented;
}

export async function getSummaryFacts(trip: Trip, ctx: FactsCtx): Promise<Fact<DestinationSummary>> {
  void trip; void ctx;
  return notImplemented;
}

export async function getPlacesFacts(
  trip: Trip,
  purpose: TripPurpose | null,
  ctx: FactsCtx,
): Promise<Fact<PlacesFacts>> {
  void trip; void purpose; void ctx;
  return notImplemented;
}

export async function getTripFacts(
  trip: Trip,
  purpose: TripPurpose | null,
  ctx: FactsCtx,
): Promise<TripFacts> {
  void purpose; void ctx;
  return {
    tripId: trip.id,
    generatedAt: new Date().toISOString(),
    referenceDates: [],
    weather: notImplemented,
    daylight: notImplemented,
    country: notImplemented,
    summary: notImplemented,
    places: notImplemented,
  };
}

export async function warmTripFacts(
  trip: Trip,
  purpose: TripPurpose | null,
  ctx: FactsCtx,
): Promise<void> {
  void trip; void purpose; void ctx;
}
