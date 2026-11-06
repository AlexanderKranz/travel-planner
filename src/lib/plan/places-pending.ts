import type { ActivityGroup, ActivityType, ActivityWish } from "@/lib/facts/activity-types";
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
 * What may block a plan (QA #139): the types the wishes name, and the groups of group-only wishes (an open wish
 * that names no type). Types an open wish only adds as options are best effort: fetched when time allows, never
 * waited for.
 */
export type BlockingScope = { types: ReadonlySet<ActivityType>; groups?: ReadonlySet<ActivityGroup> };

/** Blocking scope of purpose wishes: their named types, and the group of each wish without types. */
export function blockingScope(wishes: readonly ActivityWish[]): BlockingScope {
  const types = new Set<ActivityType>(wishes.flatMap((w) => w.types));
  const groups = new Set<ActivityGroup>(wishes.flatMap((w) => (w.types.length === 0 && w.group ? [w.group] : [])));
  return { types, groups };
}

/**
 * With per-type status (Addendum 3) a group is pending when a blocking type is `error` or `skipped` (a `partial`
 * group whose failed part holds only other types is complete enough), or, for a group-only wish, when no part of the
 * group answered at all. `cut` is final. The retry re-runs only the failed part: each part has its own cache key,
 * so the part that worked is a cache hit.
 */
const groupPending = (g: ActivityGroupLookup, scope?: BlockingScope) => {
  // Lookups built before Addendum 3 carry no per-type status: the group status decides.
  if (!g.typeStatus) return notLoaded(g);
  if (scope?.groups?.has(g.group) && notLoaded(g)) return true;
  // Per blocking type: `unrequested`, `cut`, `empty` never block. A skipped type blocks unless the whole group was
  // skipped for lack of coordinates.
  return Object.entries(g.typeStatus).some(
    ([t, s]) => (!scope || scope.types.has(t as ActivityType)) && (s === "error" || (s === "skipped" && g.reason !== "no_location")),
  );
};
const toScope = (s?: ReadonlySet<ActivityType> | BlockingScope): BlockingScope | undefined => (s instanceof Set ? { types: s } : (s as BlockingScope | undefined));

/**
 * `scope`: what may block (`blockingScope` of the purpose wishes, or a change request's types as a set); absent =
 * every type of the group counts.
 */
export function activityPlacesPending(facts: Pick<TripFacts, "activities" | "restaurants" | "cafes">, scope?: ReadonlySet<ActivityType> | BlockingScope): string[] {
  const sc = toScope(scope);
  const out = (facts.activities ?? []).filter((g) => groupPending(g, sc)).map((g) => `activities:${g.group}`);
  if (facts.restaurants && notLoaded(facts.restaurants)) out.push("restaurants");
  if (facts.cafes && notLoaded(facts.cafes)) out.push("cafes");
  return out;
}

/** Interests, activity groups and restaurants that did not load; null when nothing is pending. */
export function allPlacesPending(facts: Pick<TripFacts, "places" | "activities" | "restaurants" | "cafes">, scope?: ReadonlySet<ActivityType> | BlockingScope): string[] | null {
  const all = [...(placesPending(facts.places) ?? []), ...activityPlacesPending(facts, scope)];
  return all.length ? all : null;
}
