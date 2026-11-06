import type { Fact, PlacesFacts, TripFacts } from "@/lib/domain/facts";
import { sourceFor } from "@/lib/facts/interest-sources";

/**
 * True when places that have an OSM source did not load (Overpass timeout/error), as opposed to loading empty.
 * Generating then would silently fall back to generic activities, so the pipeline asks the user to retry [D2].
 * Free-text destinations (no_location) and interests without a source are never pending.
 */
export function placesPending(places: Fact<PlacesFacts>): string[] | null {
  if (places.status !== "ok") return places.reason === "provider_error" ? ["*"] : null;
  const pending = places.data.groups
    .filter((g) => g.status === "error" && sourceFor(g.interest).source === "osm")
    .map((g) => g.interest);
  return pending.length ? pending : null;
}

/**
 * Activity groups and restaurants whose lookup failed (`error`; never `empty` or `skipped`), labelled
 * `activities:<group>` and `restaurants`. Same rule as for interests: the pipeline asks the user to retry [D2].
 */
export function activityPlacesPending(facts: Pick<TripFacts, "activities" | "restaurants">): string[] {
  const out = (facts.activities ?? []).filter((g) => g.status === "error").map((g) => `activities:${g.group}`);
  if (facts.restaurants?.status === "error") out.push("restaurants");
  return out;
}

/** Interests, activity groups and restaurants that did not load; null when nothing is pending. */
export function allPlacesPending(facts: Pick<TripFacts, "places" | "activities" | "restaurants">): string[] | null {
  const all = [...(placesPending(facts.places) ?? []), ...activityPlacesPending(facts)];
  return all.length ? all : null;
}
