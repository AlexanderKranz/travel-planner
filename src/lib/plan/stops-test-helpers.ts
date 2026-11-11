/** Builders for the port-places unit tests (synthetic data only; not imported by app code). */
import type { PlaceCandidate, PlaceGroup, ResolvedStop, RestaurantLookup, StopFacts } from "@/lib/domain/facts";
import type { Restaurant } from "@/lib/facts/cuisine";
import type { TripStop } from "@/lib/domain/trip-stops";
import type { PlanInputStored } from "./input";
import { stopPointsOf, stopRows } from "./stops-input";
import { stopKey } from "./stops-resolve";

export const T = "2026-11-10T00:00:00.000Z";

export const cand = (osmId: number, name: string, lat: number, lon: number, category = "tourism=museum", distanceKm = 1): PlaceCandidate => ({
  osmType: "node",
  osmId,
  name,
  names: {},
  category,
  lat,
  lon,
  distanceKm,
  osmUrl: `https://www.openstreetmap.org/node/${osmId}`,
});

export const rest = (osmId: number, name: string, lat: number, lon: number, distanceKm = 0.5, cuisines: string[] = []): Restaurant => ({
  osmType: "node",
  osmId,
  name,
  cuisines,
  lat,
  lon,
  distanceKm,
  hasOpeningHours: false,
  kidsTagged: false,
  osmUrl: `https://www.openstreetmap.org/node/${osmId}`,
});

export const okRestaurants = (list: Restaurant[]): RestaurantLookup => ({ status: "ok", restaurants: list, radiusKm: 2.5, fetchedAt: T });
export const group = (interest: PlaceGroup["interest"], candidates: PlaceCandidate[]): PlaceGroup => ({ interest, status: "ok", candidates, fetchedAt: T, stale: false });

export const WIEN = { lat: 48.2085, lon: 16.3721, geoId: 2761369 };
export const DURNSTEIN = { lat: 48.3948, lon: 15.5189, geoId: 2780900 };
export const PASSAU = { lat: 48.5665, lon: 13.4312, geoId: 2855328 };

export const stopOk = (id: string, name: string, days: number[], point: ResolvedStop["point"]): ResolvedStop => ({ id, name, days, role: "stop", point, status: "ok", keys: [stopKey(name)] });

/** A small cruise: Passau (destination) on days 1 and 5, Wien day 2, Dürnstein day 3, sea day 4. */
export const CRUISE_STOPS: TripStop[] = [
  { day: 1, place: "Passau", dep: "16:00" },
  { day: 2, place: "Wien", arr: "14:00", dep: "23:59" },
  { day: 3, place: "Dürnstein", arr: "07:00", dep: "12:00" },
  { day: 4, sea: true },
  { day: 5, place: "Passau", arr: "08:00" },
];

export const CRUISE_RESOLVED: ResolvedStop[] = [
  { id: "dest", name: "Passau", days: [1, 5], role: "destination", point: PASSAU, status: "ok", keys: ["passau"] },
  stopOk("s1", "Wien", [2], WIEN),
  stopOk("s2", "Dürnstein", [3], DURNSTEIN),
];

export const CRUISE_FACTS: StopFacts[] = [
  { stop: CRUISE_RESOLVED[0], places: [] },
  {
    stop: CRUISE_RESOLVED[1],
    places: [group("family_activities", [cand(101, "Zoo Wien", 48.18, 16.3), cand(102, "Haus des Meeres", 48.19, 16.35)]), group("general", [cand(103, "Stephansdom", 48.2086, 16.3731)])],
    restaurants: okRestaurants([rest(201, "Beisl Wien", 48.209, 16.37), rest(202, "Cafe Wien", 48.21, 16.37)]),
  },
  {
    stop: CRUISE_RESOLVED[2],
    places: [group("family_activities", []), { interest: "general", status: "empty", fetchedAt: T, stale: false }],
    restaurants: okRestaurants([rest(301, "Weinstube", 48.395, 15.519)]),
  },
];

export const emptyStored = (days = 5): PlanInputStored => ({
  llm: {
    v: 1,
    lang: "de",
    trip: { dest: "Donau", kind: "region", days, flights: false, notes: "Schiff" },
    dayList: Array.from({ length: days }, (_, i) => ({ n: i + 1 })),
    places: [{ id: "p1", name: "Passauer Dom", cat: "tourism=attraction", km: 0.5, i: "general" }],
    noSource: [],
  },
  index: {
    p1: {
      key: "node/1",
      place: { name: "Passauer Dom", category: "tourism=attraction", lat: PASSAU.lat, lon: PASSAU.lon, distanceKm: 0.5, osmUrl: "https://www.openstreetmap.org/node/1", source: "osm", fetchedAt: T },
    },
  },
});

/** A stored input that already has the cruise stops, as `extendInputWithStops` makes it. */
export function storedWithStops(): PlanInputStored {
  const base = emptyStored();
  return {
    ...base,
    llm: { ...base.llm, trip: { ...base.llm.trip, stops: stopRows(CRUISE_STOPS, CRUISE_RESOLVED) } },
    stopPoints: stopPointsOf(CRUISE_RESOLVED),
  };
}
