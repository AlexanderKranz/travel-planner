/**
 * Geometry of the route sketch (docs/specs/city-tour.md section 8): the decoded leg polylines and the stops projected
 * into a box, without a base map. Pure, so the web SVG (`src/components/tour/route-sketch.tsx`) and the PDF (react-pdf
 * `Svg`) draw the same picture. Equirectangular projection with the longitude scaled by cos(latitude): exact enough
 * at city scale, and north stays up.
 */
import { decodePolyline } from "./polyline";

export type SketchLeg = { poly: string | null; dashed?: boolean };
export type SketchPoint = { lat: number; lon: number; n?: number };
export type SketchInput = { legs: readonly SketchLeg[]; points: readonly SketchPoint[]; width?: number; height?: number };

export type SketchGeometry = {
  width: number;
  height: number;
  /** One SVG path (`M x y L x y …`) per leg with a usable polyline; legs without one are left out. */
  paths: { d: string; dashed: boolean; leg: number }[];
  points: { x: number; y: number; n?: number }[];
};

export const SKETCH_WIDTH = 320;
export const SKETCH_HEIGHT = 240;
/** Room for the markers at the edge. */
const PAD = 16;

const round1 = (v: number) => Math.round(v * 10) / 10;

function decodeSafe(poly: string | null): [number, number][] | null {
  if (!poly) return null;
  try {
    const pts = decodePolyline(poly);
    return pts.length >= 2 ? pts : null;
  } catch {
    return null;
  }
}

export function sketchGeometry(input: SketchInput): SketchGeometry {
  const width = input.width ?? SKETCH_WIDTH;
  const height = input.height ?? SKETCH_HEIGHT;
  const lines = input.legs.map((l) => decodeSafe(l.poly));
  const all: [number, number][] = [...lines.flatMap((l) => l ?? []), ...input.points.map((p): [number, number] => [p.lat, p.lon])];
  if (all.length === 0) return { width, height, paths: [], points: [] };

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const [lat, lon] of all) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  const kx = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = Math.max((maxLon - minLon) * kx, 1e-9);
  const spanY = Math.max(maxLat - minLat, 1e-9);
  const scale = Math.min((width - 2 * PAD) / spanX, (height - 2 * PAD) / spanY);
  // Centre the drawing in the box.
  const offX = (width - spanX * scale) / 2;
  const offY = (height - spanY * scale) / 2;
  const project = (lat: number, lon: number) => ({
    x: round1(offX + (lon - minLon) * kx * scale),
    y: round1(offY + (maxLat - lat) * scale),
  });

  const paths = lines.flatMap((line, leg) => {
    if (!line) return [];
    const d = line
      .map(([lat, lon], i) => {
        const p = project(lat, lon);
        return `${i === 0 ? "M" : "L"}${p.x} ${p.y}`;
      })
      .join(" ");
    return [{ d, dashed: !!input.legs[leg].dashed, leg }];
  });
  const points = input.points.map((p) => ({ ...project(p.lat, p.lon), ...(p.n !== undefined ? { n: p.n } : {}) }));
  return { width, height, paths, points };
}
