import "server-only";
import { z } from "zod";
import type { Plan } from "@/lib/domain/plan";
import { MAX_TOUR_PLACES, type TourSuggestion } from "@/lib/domain/tour";
import type { Trip } from "@/lib/domain/trip";
import { addDays } from "@/lib/facts/trip-timing";
import { resolvedFromInput } from "@/lib/plan/stops-input";
import { getPlanRow, getVersion } from "../plan-store";
import { getUserSession } from "../session";
import { getTrip } from "../trips";
import { catOf } from "./places";
import { signPointRef } from "./point-ref";

/**
 * Prefill of "Stadttour für diesen Tag" (docs/specs/city-tour.md 2.2): read-only, no external call. From the trip and
 * its latest stored plan version:
 * - city: the day's resolved stop point (its GeoNames id, stored beside the plan input), else the trip destination;
 * - places: the day's referenced plan places with coordinates (OSM, verified when the plan was made), each with a
 *   signed reference like every other server-offered point (spec 3.1);
 * - date: the trip date of that day when the trip has dates.
 * Owner only in the MVP ([T15]); null when the trip is not the viewer's own, the day is outside the trip, or it
 * cannot be read. A missing or unreadable plan just gives no places.
 */
export type TourPrefillCity = { key: string; name: string; lat: number; lon: number };
export type TourPrefill = {
  tripId: string;
  day: number;
  tripTitle: string;
  city: TourPrefillCity | null;
  places: TourSuggestion[];
  date: string | null;
};

const Args = z.object({ tripId: z.string().uuid(), day: z.number().int().min(1).max(60) });

const OSM_SHORT = { node: "n", way: "w", relation: "r" } as const;
/** Plan key "node/123" → tour key "osm:n123". */
export function tourKeyOfPlanRef(ref: string): string | null {
  const m = /^(node|way|relation)\/(\d{1,15})$/.exec(ref);
  return m ? `osm:${OSM_SHORT[m[1] as keyof typeof OSM_SHORT]}${m[2]}` : null;
}

/** Places of plan day `day` in the order the plan mentions them (refs only, no alternatives), at most MAX_TOUR_PLACES. Pure. */
export function dayPlaces(plan: Pick<Plan, "days" | "places">, day: number): { key: string; name: string; lat: number; lon: number; cat: string }[] {
  const d = plan.days.find((x) => x.n === day);
  if (!d) return [];
  const out: { key: string; name: string; lat: number; lon: number; cat: string }[] = [];
  for (const act of d.stops.flatMap((s) => s.acts)) {
    if (!act.ref) continue;
    const place = plan.places[act.ref];
    const key = tourKeyOfPlanRef(act.ref);
    if (!place || !key || out.some((p) => p.key === key)) continue;
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) continue;
    out.push({ key, name: place.name.slice(0, 120) || key, lat: place.lat, lon: place.lon, cat: catOf(place.category) });
    if (out.length >= MAX_TOUR_PLACES) break;
  }
  return out;
}

function destinationCity(trip: Trip): TourPrefillCity | null {
  const d = trip.destination;
  if (d.kind === "freetext") return null;
  return { key: `geo:${d.geoId}`, name: d.placeName || d.name, lat: d.lat, lon: d.lon };
}

export async function tourPrefill(args: { tripId: string; day: number }): Promise<TourPrefill | null> {
  const parsed = Args.safeParse(args);
  if (!parsed.success) return null;
  const session = await getUserSession();
  if (!session) return null;
  const tripRes = await getTrip(parsed.data.tripId);
  if (!tripRes.ok) return null;
  const trip = tripRes.data;
  if (trip.access !== "owner" || parsed.data.day > trip.lengthDays) return null;
  const day = parsed.data.day;

  let city = destinationCity(trip);
  let places: TourPrefill["places"] = [];
  try {
    const row = await getPlanRow(session.supabase, trip.id);
    const version = row ? await getVersion(session.supabase, row.id, row.latestVersion) : null;
    if (version) {
      const stop = resolvedFromInput(version.input).find((s) => s.point && s.days.includes(day));
      if (stop?.point) city = { key: `geo:${stop.point.geoId}`, name: stop.name.slice(0, 120), lat: stop.point.lat, lon: stop.point.lon };
      places = dayPlaces(version.plan, day).map((p) => {
        const point = { key: p.key, name: p.name, lat: p.lat, lon: p.lon, source: "osm" as const, ...(p.cat ? { cat: p.cat } : {}) };
        return { ...point, ref: signPointRef(point) };
      });
    }
  } catch {
    // No plan places: the form still opens with the city and the date.
  }
  return {
    tripId: trip.id,
    day,
    tripTitle: trip.title ?? trip.destination.name,
    city,
    places,
    date: trip.timing.kind === "date" ? addDays(trip.timing.startDate, day - 1) : null,
  };
}
