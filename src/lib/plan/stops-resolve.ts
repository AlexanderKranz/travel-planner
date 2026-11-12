/**
 * Trip stops -> resolved stops (docs/specs/port-places.md section 1). Pure: the geocoding happens in
 * `src/lib/server/facts/stops.ts`, this file decides names, roles, ids and the cap from its results.
 */
import type { ResolvedStop } from "@/lib/domain/facts";
import type { TripStop } from "@/lib/domain/trip-stops";
import { foldName } from "@/lib/discover/names";
import { haversineKm } from "@/lib/facts/places";

/** Looked-up stops per trip (port-places [P6]); later ones are `cap` and reported as not checked. */
export const MAX_STOPS = 10;
/** A stop this close to the trip anchor counts as the destination (its lookups apply, [P1]). */
export const DESTINATION_KM = 5;
/** Names geocoded per trip: the looked-up stops plus names that were not found or are the destination. */
export const MAX_GEOCODED_NAMES = 16;

export type GeocodeOutcome =
  | { status: "ok"; name: string; point: { lat: number; lon: number; geoId: number } }
  | { status: "not_found" }
  | { status: "error" };

/**
 * Key of a typed place name: accents, case and spacing ignored ("Dürnstein" = "durnstein"). With a country the key
 * carries it, so "Cartagena" (ES) and "Cartagena" (CO) are two stops; without one the key is the folded name.
 */
export const stopKey = (place: string, cc?: string): string => {
  const name = foldName(place);
  return name && cc ? `${name}|${cc}` : name;
};

export type StopName = { key: string; name: string; cc?: string };

/** Distinct place names of the stops in day order (sea rows have none); the first spelling and `cc` win. */
export function distinctStopNames(stops: readonly TripStop[]): StopName[] {
  const out: StopName[] = [];
  const seen = new Set<string>();
  for (const s of stops) {
    if (s.sea || !s.place) continue;
    const key = stopKey(s.place, s.cc);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, name: s.place, ...(s.cc ? { cc: s.cc } : {}) });
  }
  return out;
}

/**
 * Names to geocode: the first MAX_GEOCODED_NAMES of `distinctStopNames`. The rest becomes `cap` without a call (the
 * trip lists far more places than the app looks up).
 */
export const namesToGeocode = (stops: readonly TripStop[]): StopName[] => distinctStopNames(stops).slice(0, MAX_GEOCODED_NAMES);

/**
 * Geocoding outcomes -> resolved stops, in day order.
 * - A found place within DESTINATION_KM of `anchor` is the destination (id "dest", role destination).
 * - Every other name is a stop with id `s1..` in order of first appearance, also when it was not found, failed or is
 *   over the cap (the plan input and the notices name it).
 * - A place keyed by `geoId` is one stop on every day it appears; two typed names of one place merge.
 * - The first MAX_STOPS found stops are `ok`; later ones are `cap`. A name without an outcome (never geocoded) is `cap`.
 */
export function assignStops(
  stops: readonly TripStop[],
  outcomes: ReadonlyMap<string, GeocodeOutcome>,
  anchor: { lat: number; lon: number } | null,
): ResolvedStop[] {
  const out: ResolvedStop[] = [];
  const byKey = new Map<string, ResolvedStop>();
  const byGeoId = new Map<number, ResolvedStop>();
  let dest: ResolvedStop | undefined;
  let n = 0;
  let looked = 0;
  const addDay = (r: ResolvedStop, day: number, key: string) => {
    if (!r.days.includes(day)) r.days.push(day);
    if (!r.keys?.includes(key)) r.keys = [...(r.keys ?? []), key];
  };
  for (const s of stops) {
    if (s.sea || !s.place) continue;
    const key = stopKey(s.place, s.cc);
    if (!key) continue;
    const known = byKey.get(key);
    if (known) {
      addDay(known, s.day, key);
      continue;
    }
    const o = outcomes.get(key);
    let r: ResolvedStop;
    if (o?.status === "ok") {
      const same = byGeoId.get(o.point.geoId);
      if (same) {
        addDay(same, s.day, key);
        byKey.set(key, same);
        continue;
      }
      if (anchor && haversineKm(anchor, o.point) <= DESTINATION_KM) {
        // The destination is one entry however many names or days reach it.
        if (!dest) {
          dest = { id: "dest", name: o.name, days: [], role: "destination", point: o.point, status: "ok" };
          out.push(dest);
        }
        byGeoId.set(o.point.geoId, dest);
        byKey.set(key, dest);
        addDay(dest, s.day, key);
        continue;
      }
      if (looked < MAX_STOPS) {
        looked += 1;
        r = { id: `s${++n}`, name: o.name, days: [], role: "stop", point: o.point, status: "ok" };
      } else {
        r = { id: `s${++n}`, name: o.name, days: [], role: "stop", status: "cap" };
      }
      byGeoId.set(o.point.geoId, r);
    } else {
      const status = o?.status === "not_found" ? "not_found" : o?.status === "error" ? "error" : "cap";
      r = { id: `s${++n}`, name: s.place.trim(), days: [], role: "stop", status };
    }
    addDay(r, s.day, key);
    byKey.set(key, r);
    out.push(r);
  }
  return out.map((r) => ({ ...r, days: [...r.days].sort((a, b) => a - b) }));
}

/** The resolved stop a typed stop row belongs to. */
export function stopOfRow(row: Pick<TripStop, "place" | "sea"> & { cc?: string }, resolved: readonly ResolvedStop[]): ResolvedStop | undefined {
  if (row.sea || !row.place) return undefined;
  const key = stopKey(row.place, row.cc);
  return resolved.find((r) => r.keys?.includes(key));
}
