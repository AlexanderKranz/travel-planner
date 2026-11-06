import "server-only";
import type { ActivityGroupLookup, FactsCtx, RestaurantLookup } from "@/lib/domain/facts";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import { groupsForWishes, type ActivityGroup } from "@/lib/facts/activity-types";
import { getActivityGroupFacts, getRestaurantFacts, type ActivityGroupFacts, type LookupFact, type RestaurantFacts } from "./activities";
import { geoDestination, type GeoDestination } from "./common";
import { PLACES_CACHE_ONLY, VIEW_BUDGET_MS } from "./places";

/** LookupFact (data layer) -> the compact lookup kept in TripFacts. */
export function groupLookup(group: ActivityGroup, f: LookupFact<ActivityGroupFacts>): ActivityGroupLookup {
  if (f.status === "ok" || f.status === "empty") return { group, status: f.status, places: f.data.places, fetchedAt: f.fetchedAt };
  return { group, status: f.status, places: [] };
}

export function restaurantLookup(f: LookupFact<RestaurantFacts>): RestaurantLookup {
  if (f.status === "ok" || f.status === "empty") {
    return { status: f.status, restaurants: f.data.restaurants, radiusKm: f.data.radiusKm, fetchedAt: f.fetchedAt };
  }
  return { status: f.status, restaurants: [] };
}

/** Remaining budget of a shared window; cache only stays cache only, and an exhausted window becomes cache only. */
function remaining(budgetMs: number, started: number): number {
  if (budgetMs === PLACES_CACHE_ONLY) return PLACES_CACHE_ONLY;
  return Math.max(PLACES_CACHE_ONLY, budgetMs - (Date.now() - started));
}

const failed = { status: "error", source: "osm" } as const;

export type ActivityLookupRequest = {
  groups: readonly ActivityGroup[];
  /** false = no restaurants; `near` = within 1.5 km of that point (change requests). */
  restaurants?: { near?: { lat: number; lon: number } } | false;
};

/**
 * Restaurants and activity groups, one after the other in one shared budget (Overpass has 2 slots per IP; the
 * interest lookups use the other one). Restaurants first: every plan needs them. Never throws.
 */
export async function loadActivityLookups(
  dest: GeoDestination | null,
  req: ActivityLookupRequest,
  ctx: FactsCtx,
  budgetMs: number,
): Promise<{ activities: ActivityGroupLookup[]; restaurants?: RestaurantLookup }> {
  const started = Date.now();
  let restaurants: RestaurantLookup | undefined;
  if (req.restaurants !== false) {
    const near = req.restaurants?.near;
    const f = await getRestaurantFacts(dest, ctx, { budgetMs: remaining(budgetMs, started), ...(near ? { near } : {}) }).catch(() => failed);
    restaurants = restaurantLookup(f);
  }
  const activities: ActivityGroupLookup[] = [];
  for (const group of req.groups) {
    const f = await getActivityGroupFacts(group, dest, ctx, { budgetMs: remaining(budgetMs, started) }).catch(() => failed);
    activities.push(groupLookup(group, f));
  }
  return { activities, ...(restaurants ? { restaurants } : {}) };
}

/** What a trip's plan needs (spec sections 2 and 3): the groups of the purpose wishes, and restaurants always. */
export async function getTripActivityFacts(
  trip: Trip,
  purpose: TripPurpose | null,
  ctx: FactsCtx,
  budgetMs: number = VIEW_BUDGET_MS,
): Promise<{ activities?: ActivityGroupLookup[]; restaurants?: RestaurantLookup }> {
  const groups = groupsForWishes(purpose?.tags?.activities ?? []);
  const r = await loadActivityLookups(geoDestination(trip), { groups }, ctx, budgetMs);
  return { ...(r.activities.length ? { activities: r.activities } : {}), ...(r.restaurants ? { restaurants: r.restaurants } : {}) };
}
