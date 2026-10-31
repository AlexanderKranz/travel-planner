import type { GeoPlace } from "@/lib/domain";
import { haversineKm } from "@/lib/facts/places";
import { isValidTimeZone } from "@/lib/facts/time-difference";
import { placeLabel } from "@/lib/geocode-client";

/** A geocoding hit must lie this close to the airport to count as "its" place (airports sit outside the city). */
export const MAX_SUGGESTION_KM = 100;

export type HomeSuggestion = { name: string; timezone: string };
export type SuggestionAirport = { city: string; country: string; lat: number; lon: number };

/**
 * Home place suggested by the first home airport: the geocoding result (searched by the airport's city) in the
 * same country, closest to the airport and within MAX_SUGGESTION_KM, that has a valid IANA zone. Null when none.
 * Pure. Suggestion only: the caller saves nothing.
 */
export function pickHomeSuggestion(airport: SuggestionAirport, places: GeoPlace[], locale: string): HomeSuggestion | null {
  const ranked = places
    .filter((p) => p.timezone && isValidTimeZone(p.timezone) && p.countryCode?.toUpperCase() === airport.country.toUpperCase())
    .map((p) => ({ p, km: haversineKm(airport, p) }))
    .filter((x) => x.km <= MAX_SUGGESTION_KM)
    .sort((a, b) => a.km - b.km);
  const best = ranked[0]?.p;
  return best?.timezone ? { name: placeLabel(best, locale), timezone: best.timezone } : null;
}

/** Whether the form should offer a suggestion at all: nothing saved or picked as home, at least one airport. */
export function shouldSuggestHome(home: unknown, airports: string[]): boolean {
  return home == null && airports.length > 0;
}
