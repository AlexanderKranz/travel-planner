/**
 * Sights near the route (docs/specs/city-tour.md section 6 [T12]). Pure: candidates come from the cached city
 * places in their existing `rankCandidates` order; legs are decoded polylines.
 */
import {
  CORRIDOR_M,
  MAX_SIGHTS_PER_LEG,
  MAX_TOUR_SIGHTS,
  type TourMode,
  type TourSight,
} from "@/lib/domain/tour";
import { pointToPolylineM } from "./geo";
import type { LatLon } from "./polyline";

export type SightCandidate = { key: string; name: string; lat: number; lon: number; cat: string; url?: string };
/** One leg of the tour: its mode (corridor width) and decoded geometry (null when the leg failed). */
export type SightLeg = { mode: TourMode; line: readonly LatLon[] | null };

/**
 * Keeps candidates within the corridor of a leg (width by that leg's mode), each assigned to the nearest leg among
 * those whose corridor contains it (ties: lower leg index). Tour points (`exclude`) and repeated keys are skipped.
 * Caps: 3 per leg, 8 per tour, taken in the given rank order, which the output keeps.
 */
export function sightsNearRoute(
  candidates: readonly SightCandidate[],
  legs: readonly SightLeg[],
  exclude: Iterable<string>,
): TourSight[] {
  const skip = new Set(exclude);
  const perLeg = new Map<number, number>();
  const out: TourSight[] = [];
  for (const c of candidates) {
    if (out.length >= MAX_TOUR_SIGHTS) break;
    if (skip.has(c.key)) continue;
    let leg = -1;
    let best = Infinity;
    legs.forEach((l, i) => {
      if (!l.line?.length) return;
      const d = pointToPolylineM(c, l.line);
      if (d <= CORRIDOR_M[l.mode] && d < best) {
        best = d;
        leg = i;
      }
    });
    if (leg < 0 || (perLeg.get(leg) ?? 0) >= MAX_SIGHTS_PER_LEG) continue;
    perLeg.set(leg, (perLeg.get(leg) ?? 0) + 1);
    skip.add(c.key);
    out.push({
      key: c.key,
      name: c.name,
      lat: c.lat,
      lon: c.lon,
      leg,
      m: Math.round(best),
      cat: c.cat,
      ...(c.url ? { url: c.url } : {}),
    });
  }
  return out;
}
