import type { ActivityType } from "@/lib/facts/activity-types";
import type { ActivityGroupLookup, Fact, PlacesFacts, TripFacts } from "@/lib/domain/facts";
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
/**
 * With per-type status (Addendum 3) a group is pending when a wished type is `error` or `skipped` (a `partial` group
 * whose failed part holds only unwished types is complete enough). `cut` is final. The retry re-runs only the failed
 * part: each part has its own cache key, so the part that worked is a cache hit.
 */
const groupPending = (g: ActivityGroupLookup, wanted?: ReadonlySet<ActivityType>) => {
  // Lookups built before Addendum 3 carry no per-type status: the group status decides.
  if (!g.typeStatus) return notLoaded(g);
  // Per wished type (QA #139): a failed or skipped type nobody wished never blocks; `unrequested`, `cut`, `empty` never do.
  // A skipped type is pending unless the whole group was skipped for lack of coordinates.
  return Object.entries(g.typeStatus).some(
    ([t, s]) => (!wanted || wanted.has(t as ActivityType)) && (s === "error" || (s === "skipped" && g.reason !== "no_location")),
  );
};
/** `wanted`: the wished types (`wishedTypes`, or a change request's types); absent = every type of the group counts. */
export function activityPlacesPending(facts: Pick<TripFacts, "activities" | "restaurants" | "cafes">, wanted?: ReadonlySet<ActivityType>): string[] {
  const out = (facts.activities ?? []).filter((g) => groupPending(g, wanted)).map((g) => `activities:${g.group}`);
  if (facts.restaurants && notLoaded(facts.restaurants)) out.push("restaurants");
  if (facts.cafes && notLoaded(facts.cafes)) out.push("cafes");
  return out;
}

/** Interests, activity groups and restaurants that did not load; null when nothing is pending. */
export function allPlacesPending(facts: Pick<TripFacts, "places" | "activities" | "restaurants" | "cafes">, wanted?: ReadonlySet<ActivityType>): string[] | null {
  const all = [...(placesPending(facts.places) ?? []), ...activityPlacesPending(facts, wanted)];
  return all.length ? all : null;
}
