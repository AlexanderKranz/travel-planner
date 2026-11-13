/**
 * "In Google Maps öffnen" (docs/specs/city-tour.md section 8). Pure. Google allows 9 waypoints between origin and
 * destination, so a longer tour is split into consecutive links; each next link starts where the previous ended.
 * Per-leg overrides are not expressible in the URL; the tour mode is used (the label says Google may route
 * differently).
 */
import type { TourMode } from "@/lib/domain/tour";

/**
 * Spec 8 splits beyond 9 waypoints (the limit in the Google Maps app and on desktop). Google's docs allow only 3 in a
 * mobile browser without the app; pass `maxWaypoints: 3` for that case.
 */
export const GOOGLE_MAX_WAYPOINTS = 9;

const TRAVELMODE: Record<TourMode, string> = {
  foot: "walking",
  wheelchair: "walking",
  cycling: "bicycling",
  ebike: "bicycling",
  car: "driving",
};

const coord = (p: { lat: number; lon: number }) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

function link(points: readonly { lat: number; lon: number }[], mode: TourMode): string {
  const q = new URLSearchParams({ api: "1", origin: coord(points[0]), destination: coord(points.at(-1)!) });
  if (points.length > 2) q.set("waypoints", points.slice(1, -1).map(coord).join("|"));
  q.set("travelmode", TRAVELMODE[mode]);
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}

/** Links for the ordered stops (a round trip lists the start again at the end); empty for fewer than 2 points. */
export function googleMapsLinks(
  points: readonly { lat: number; lon: number }[],
  mode: TourMode,
  maxWaypoints: number = GOOGLE_MAX_WAYPOINTS,
): string[] {
  if (points.length < 2) return [];
  const per = Math.max(0, Math.floor(maxWaypoints)) + 1; // legs per link: origin + waypoints + destination
  const out: string[] = [];
  for (let i = 0; i < points.length - 1; i += per) out.push(link(points.slice(i, i + per + 1), mode));
  return out;
}
