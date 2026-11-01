import type { GeoPlace } from "@/lib/domain";
import { haversineKm } from "@/lib/facts/places";
import { isValidTimeZone } from "@/lib/facts/time-difference";
import { placeLabel } from "@/lib/geocode-client";

/** A geocoding hit must lie this close to the airport to count as "its" place (airports sit outside the city). */
export const MAX_SUGGESTION_KM = 150;

export type HomeSuggestion = { name: string; timezone: string; geoId: number };
export type SuggestionAirport = { city: string; country: string; lat: number; lon: number };

/** "Frankfurt am Main (Lautzenhausen)" -> "Frankfurt am Main", "Bâle / Mulhouse" -> "Bâle". Search term for the geocoder. */
export function cleanAirportCity(city: string): string {
  return city.replace(/\([^)]*\)/g, " ").split(" / ")[0].replace(/\s+/g, " ").trim();
}

/**
 * Home place suggested by the first home airport: among the geocoding results (searched by the cleaned airport
 * city) only populated places (GeoNames PPL*, so no airports, hills or regions) in the same country within
 * MAX_SUGGESTION_KM that have a valid IANA zone; the most populous wins (Zürich over Zürichberg). Null when none.
 * Pure. Suggestion only: the caller saves nothing.
 */
export function pickHomeSuggestion(airport: SuggestionAirport, places: GeoPlace[], locale: string): HomeSuggestion | null {
  const ranked = places
    .filter(
      (p) =>
        p.featureCode.startsWith("PPL") &&
        p.timezone &&
        isValidTimeZone(p.timezone) &&
        p.countryCode?.toUpperCase() === airport.country.toUpperCase() &&
        haversineKm(airport, p) <= MAX_SUGGESTION_KM,
    )
    .sort((a, b) => (b.population ?? 0) - (a.population ?? 0) || haversineKm(airport, a) - haversineKm(airport, b));
  const best = ranked[0];
  return best?.timezone ? { name: placeLabel(best, locale), timezone: best.timezone, geoId: best.geoId } : null;
}

/** Whether the form should offer a suggestion at all: nothing saved or picked as home, at least one airport. */
export function shouldSuggestHome(home: unknown, airports: string[]): boolean {
  return home == null && airports.length > 0;
}
