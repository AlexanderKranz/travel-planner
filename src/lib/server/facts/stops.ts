import "server-only";
import type { FactsCtx, PlaceGroup, ResolvedStop, StopFacts } from "@/lib/domain/facts";
import type { TripPurpose } from "@/lib/domain/purpose";
import { DEFAULT_RADIUS_KM, type Trip } from "@/lib/domain/trip";
import type { TripStop } from "@/lib/domain/trip-stops";
import { interestsForTrip, sourceFor } from "@/lib/facts/interest-sources";
import { assignStops, namesToGeocode, type GeocodeOutcome, type StopName } from "@/lib/plan/stops-resolve";
import { stopDrivePicks } from "@/lib/plan/stops-input";
import type { DriveInput } from "@/lib/plan/input";
import { defaultGeocodeDeps, resolvePlaceName, type GeocodeDeps } from "../discover/resolve-place";
import { getCafeFacts, getRestaurantFacts } from "./activities";
import { cafeLookup, restaurantLookup } from "./activity-lookups";
import type { GeoDestination } from "./common";
import { getDriveTimes } from "./drive-times";
import { PLACES_CACHE_ONLY, getInterestGroups } from "./places";

/** Interests looked up per stop: the first two of the purpose that have an OSM source (port-places [P4]). */
export const STOP_INTERESTS = 2;
/** Stops are looked up one after the other (Overpass has 2 slots per IP, Geoapify 5 requests per second). */
export const STOP_CONCURRENCY = 1;
/** Names geocoded at the same time (Open-Meteo is keyless; 4 stay far below its limits). */
const GEOCODE_CONCURRENCY = 4;
/** All stop drive matrices must be done inside this window (the existing ORS budget of a plan run). */
export const STOP_DRIVE_BUDGET_MS = 10_000;

/** A stop as a destination of kind city: the existing lookups run unchanged around it (same cache keys). */
export function stopDestination(stop: Pick<ResolvedStop, "name"> & { point: NonNullable<ResolvedStop["point"]> }): GeoDestination {
  return {
    kind: "city",
    name: stop.name,
    placeName: stop.name,
    geoId: stop.point.geoId,
    countryCode: null,
    admin1: null,
    lat: stop.point.lat,
    lon: stop.point.lon,
    timezone: null,
    radiusKm: DEFAULT_RADIUS_KM.city,
  };
}

/**
 * The stops of a trip -> resolved stops: each distinct place name geocoded by code (`resolvePlaceName`, cached), the
 * role and id decided by `assignStops`. Country: the stop's `cc`, else none: the namesake nearest the previous stop (the trip anchor for the first) wins. Never throws; a name whose
 * geocoding failed is a stop with status `error`.
 */
export async function resolveStopPlaces(
  trip: Pick<Trip, "destination">,
  stops: readonly TripStop[],
  ctx: FactsCtx,
  deps: GeocodeDeps = defaultGeocodeDeps,
): Promise<ResolvedStop[]> {
  const names = namesToGeocode(stops);
  if (!names.length) return [];
  const dest = trip.destination.kind === "freetext" ? null : trip.destination;
  const anchor = dest ? { lat: dest.lat, lon: dest.lon } : null;
  const lang = ctx.locale;
  const outcomes = new Map<string, GeocodeOutcome>();
  const resolveOne = async (n: StopName, prev: { lat: number; lon: number } | null) => {
    try {
      // No `cc`: the destination's country is not assumed; the namesake nearest the route decides (port-places [P1]).
      const r = await resolvePlaceName(n.name, n.cc, lang, ctx.userId ?? "", deps, { near: { prev, anchor } });
      outcomes.set(
        n.key,
        r.status === "ok"
          ? { status: "ok", name: r.place.name, point: { lat: r.place.lat, lon: r.place.lon, geoId: r.place.geoId }, ...(r.place.countryCode ? { countryCode: r.place.countryCode } : {}) }
          : r.status === "not_found"
            ? { status: "not_found" }
            : { status: "error" },
      );
    } catch {
      outcomes.set(n.key, { status: "error" });
    }
  };
  // Names with a country do not depend on the route: in parallel.
  const withCc = names.filter((n) => n.cc);
  let next = 0;
  const worker = async () => {
    while (next < withCc.length) await resolveOne(withCc[next++], null);
  };
  await Promise.all(Array.from({ length: Math.min(GEOCODE_CONCURRENCY, withCc.length) }, worker));
  // Names without one are resolved in day order, each against the previous resolved stop of the route.
  for (let i = 0; i < names.length; i++) {
    if (names[i].cc) continue;
    let prev: { lat: number; lon: number } | null = null;
    for (let j = i - 1; j >= 0 && !prev; j--) {
      const o = outcomes.get(names[j].key);
      if (o?.status === "ok") prev = o.point;
    }
    await resolveOne(names[i], prev);
  }
  return assignStops(stops, outcomes, anchor);
}

/** The interests looked up around every stop: the purpose's first two with an OSM source, `general` when none. */
export function stopInterests(purpose: Pick<TripPurpose, "guided" | "tags"> | null): ReturnType<typeof interestsForTrip>["keys"] {
  const keys = interestsForTrip(purpose?.guided, purpose?.tags).keys.filter((k) => sourceFor(k).source === "osm").slice(0, STOP_INTERESTS);
  return keys.length ? keys : ["general"];
}

export type StopLookupOptions = {
  /** Time for all stops together; PLACES_CACHE_ONLY = caches only. Stops not reached get cache-only reads. */
  budgetMs: number;
  /** "cache_only": inline runs (Generate, patch) never query Overpass over the network for stops [P7]. */
  overpass: "cache_only" | "allowed";
  /** Cafés are looked up when the purpose or a change request asks for them. */
  cafes?: boolean;
};

const failedGroup = (keys: readonly PlaceGroup["interest"][]): PlaceGroup[] => keys.map((interest) => ({ interest, status: "error" as const }));

/**
 * Restaurants, interest places and (when asked) cafés around one stop, one after the other in the shared budget.
 * Same functions, radii and cache keys as for a city trip to that town; never throws.
 */
export async function lookupAroundStop(
  stop: ResolvedStop,
  purpose: Pick<TripPurpose, "guided" | "tags"> | null,
  ctx: FactsCtx,
  opts: StopLookupOptions,
): Promise<StopFacts> {
  if (!stop.point) return { stop, places: [] };
  const dest = stopDestination({ name: stop.name, point: stop.point });
  const started = Date.now();
  const left = () => (opts.budgetMs === PLACES_CACHE_ONLY ? PLACES_CACHE_ONLY : Math.max(PLACES_CACHE_ONLY, opts.budgetMs - (Date.now() - started)));
  const overpass = opts.overpass === "cache_only" ? ({ overpass: "cache_only" } as const) : {};
  const keys = stopInterests(purpose);
  const fail = { status: "error", source: "osm" } as const;
  const restaurants = restaurantLookup(await getRestaurantFacts(dest, ctx, { budgetMs: left(), ...overpass }).catch(() => fail));
  const places = await getInterestGroups(dest, keys, ctx, left(), overpass).catch(() => failedGroup(keys));
  const wantsCafes = opts.cafes ?? purpose?.tags?.cafes === true;
  const cafes = wantsCafes ? cafeLookup(await getCafeFacts(dest, ctx, { budgetMs: left(), ...overpass }).catch(() => fail)) : undefined;
  return { stop, places, restaurants, ...(cafes ? { cafes } : {}) };
}

/**
 * Lookups for the looked-up stops of `resolved`, one stop at a time, within one shared budget (a stop the budget no
 * longer reaches is read from the caches only, so a miss is `skipped`, not `error`). Entries for destination, not
 * found, failed and capped stops carry no lookups. Same order as `resolved`.
 */
export async function lookupStops(
  resolved: readonly ResolvedStop[],
  purpose: Pick<TripPurpose, "guided" | "tags"> | null,
  ctx: FactsCtx,
  opts: StopLookupOptions,
): Promise<StopFacts[]> {
  const started = Date.now();
  const out: StopFacts[] = [];
  for (const stop of resolved) {
    if (stop.role !== "stop" || stop.status !== "ok") {
      out.push({ stop, places: [] });
      continue;
    }
    const budgetMs = opts.budgetMs === PLACES_CACHE_ONLY ? PLACES_CACHE_ONLY : Math.max(PLACES_CACHE_ONLY, opts.budgetMs - (Date.now() - started));
    out.push(await lookupAroundStop(stop, purpose, ctx, { ...opts, budgetMs }));
  }
  return out;
}

/**
 * Drive times from each stop point to the places of that stop: one cached ORS matrix per stop ([P5]), all in parallel
 * inside STOP_DRIVE_BUDGET_MS. A stop without a result (quota, error, no key, too slow) has no drive times. Never throws.
 */
export async function stopDriveTimes(facts: readonly StopFacts[], ctx: FactsCtx, budgetMs: number = STOP_DRIVE_BUDGET_MS): Promise<Record<string, DriveInput>> {
  const out: Record<string, DriveInput> = {};
  const jobs = facts.flatMap((f) => {
    const picks = stopDrivePicks(f);
    return f.stop.point && picks.length ? [{ id: f.stop.id, point: f.stop.point, picks }] : [];
  });
  if (!jobs.length) return out;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  try {
    await Promise.race([
      Promise.all(
        jobs.map(async (j) => {
          const r = await getDriveTimes({ lat: j.point.lat, lon: j.point.lon }, j.picks, ctx).catch(() => null);
          if (r) out[j.id] = r;
        }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
  // A matrix that finished after the window is dropped, so the input never depends on a race.
  return { ...out };
}

/** Everything the plan needs around the stops of a trip: geocoding, then the lookups. Never throws; no stops = []. */
export async function getStopFacts(
  trip: Pick<Trip, "destination">,
  stops: readonly TripStop[],
  purpose: Pick<TripPurpose, "guided" | "tags"> | null,
  ctx: FactsCtx,
  opts: StopLookupOptions,
): Promise<StopFacts[]> {
  if (!stops.length) return [];
  try {
    const resolved = await resolveStopPlaces(trip, stops, ctx);
    return await lookupStops(resolved, purpose, ctx, opts);
  } catch {
    return [];
  }
}
