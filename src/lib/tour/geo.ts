/**
 * Straight-line distances at city scale (spec 6): equirectangular projection around the query point, metres. Pure.
 * For long distances use `haversineKm` from `@/lib/facts/places`.
 */
import type { LatLon } from "./polyline";

const R = 6_371_008.8;
const RAD = Math.PI / 180;

type Pt = { lat: number; lon: number };

/** Project to local metres (x east, y north) around `o`. */
function project(o: Pt, lat: number, lon: number): [number, number] {
  const dLon = ((((lon - o.lon) % 360) + 540) % 360) - 180; // shortest way, also across the antimeridian
  return [dLon * RAD * Math.cos(o.lat * RAD) * R, (lat - o.lat) * RAD * R];
}

/** Distance in metres from `p` to the segment a–b. */
export function pointToSegmentM(p: Pt, a: LatLon, b: LatLon): number {
  const [ax, ay] = project(p, a[0], a[1]);
  const [bx, by] = project(p, b[0], b[1]);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Distance in metres from `p` to the polyline (Infinity for an empty line). */
export function pointToPolylineM(p: Pt, line: readonly LatLon[]): number {
  if (line.length === 1) return pointToSegmentM(p, line[0], line[0]);
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) best = Math.min(best, pointToSegmentM(p, line[i], line[i + 1]));
  return best;
}
