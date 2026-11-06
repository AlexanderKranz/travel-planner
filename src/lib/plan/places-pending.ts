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
 * Activity groups, restaurants and cafés that did not load, labelled `activities:<group>`, `restaurants`, `cafes`: `error`, and
 * `skipped` because the shared budget ran out (`cache_only`: network denied, nothing cached). Same rule as for
 * interests: the pipeline asks the user to retry [D2] and the retry or warm-up completes them. Never pending:
 * `empty`, and a free-text destination (`no_location`). "Generate anyway" (`force`) passes through in the caller.
 */
const notLoaded = (l: { status: string; reason?: string }) => l.status === "error" || (l.status === "skipped" && l.reason === "cache_only");
export function activityPlacesPending(facts: Pick<TripFacts, "activities" | "restaurants" | "cafes">): string[] {
  const out = (facts.activities ?? []).filter(notLoaded).map((g) => `activities:${g.group}`);
  if (facts.restaurants && notLoaded(facts.restaurants)) out.push("restaurants");
  if (facts.cafes && notLoaded(facts.cafes)) out.push("cafes");
  return out;
}

/** Interests, activity groups and restaurants that did not load; null when nothing is pending. */
export function allPlacesPending(facts: Pick<TripFacts, "places" | "activities" | "restaurants" | "cafes">): string[] | null {
  const all = [...(placesPending(facts.places) ?? []), ...activityPlacesPending(facts)];
  return all.length ? all : null;
}
