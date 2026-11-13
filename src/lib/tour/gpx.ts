/**
 * GPX 1.1 of a tour route (spec 17.1 [P2]): one waypoint per stop (in tour order) and one track with a segment per
 * leg, from the encoded leg polylines of one Directions answer. Pure; built in the browser, 0 calls. Navigation apps
 * (OsmAnd, Organic Maps, Komoot) then follow exactly this route.
 */
import { decodePolyline } from "./polyline";

export type GpxStop = { name: string; lat: number; lon: number };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const c = (n: number) => n.toFixed(5);

export function buildGpx(p: { name: string; stops: readonly GpxStop[]; legs: readonly (string | null)[]; creator: string }): string {
  const wpts = p.stops.map((s) => `  <wpt lat="${c(s.lat)}" lon="${c(s.lon)}"><name>${esc(s.name)}</name></wpt>`);
  const segs = p.legs
    .filter((poly): poly is string => !!poly)
    .map((poly) => {
      const pts = decodePolyline(poly).map(([lat, lon]) => `      <trkpt lat="${c(lat)}" lon="${c(lon)}"/>`);
      return ["    <trkseg>", ...pts, "    </trkseg>"].join("\n");
    });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="${esc(p.creator)}" xmlns="http://www.topografix.com/GPX/1/1">`,
    `  <metadata><name>${esc(p.name)}</name></metadata>`,
    ...wpts,
    `  <trk><name>${esc(p.name)}</name>`,
    ...segs,
    `  </trk>`,
    `</gpx>`,
    "",
  ].join("\n");
}

/** File name: the tour title reduced to safe characters, plus `.gpx`. */
export function gpxFileName(title: string): string {
  const base = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${base || "tour"}.gpx`;
}
