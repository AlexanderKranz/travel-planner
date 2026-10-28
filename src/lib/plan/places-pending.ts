import type { Fact, PlacesFacts } from "@/lib/domain/facts";
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
