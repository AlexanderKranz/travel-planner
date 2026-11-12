import { decodePolyline, type LatLon } from "./polyline";

/**
 * Route sketch geometry (docs/specs/city-tour.md section 8): the stored leg polylines and the numbered stops projected
 * into a `width` × `height` box, no base map. Pure; the web SVG and the react-pdf `Svg` draw the same output.
 * Projection: equirectangular around the mean latitude, enough at city scale; one scale for both axes.
 */
export type SketchLeg = { poly: string | null; dashed?: boolean };
export type SketchPoint = { lat: number; lon: number; n?: number };
export type SketchGeometry = {
  paths: { d: string; dashed: boolean }[];
  dots: { x: number; y: number; n?: number }[];
};

const decode = (poly: string): LatLon[] => {
  try {
    return decodePolyline(poly);
  } catch {
    return []; // a damaged polyline costs its line, not the sketch
  }
};

const r1 = (n: number) => Math.round(n * 10) / 10;

export function sketchGeometry(
  legs: readonly SketchLeg[],
  points: readonly SketchPoint[],
  width: number,
  height: number,
  pad = 10,
): SketchGeometry | null {
  const lines = legs.map((l) => ({ pts: l.poly ? decode(l.poly) : [], dashed: !!l.dashed }));
  const all: LatLon[] = [...lines.flatMap((l) => l.pts), ...points.map((p): LatLon => [p.lat, p.lon])];
  if (!all.length) return null;
  const k = Math.cos((all.reduce((s, [lat]) => s + lat, 0) / all.length) * (Math.PI / 180));
  const xs = all.map(([, lon]) => lon * k);
  const ys = all.map(([lat]) => lat);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const w = Math.max(1, width - 2 * pad);
  const h = Math.max(1, height - 2 * pad);
  const scale = Math.min(w / Math.max(maxX - minX, 1e-9), h / Math.max(maxY - minY, 1e-9));
  // Centre the drawing in the box.
  const ox = pad + (w - (maxX - minX) * scale) / 2;
  const oy = pad + (h - (maxY - minY) * scale) / 2;
  const at = ([lat, lon]: LatLon) => ({ x: r1(ox + (lon * k - minX) * scale), y: r1(oy + (maxY - lat) * scale) });
  const paths = lines
    .filter((l) => l.pts.length >= 2)
    .map((l) => ({ d: l.pts.map((p, i) => `${i ? "L" : "M"}${at(p).x} ${at(p).y}`).join(" "), dashed: l.dashed }));
  const dots = points.map((p) => ({ ...at([p.lat, p.lon]), ...(p.n !== undefined ? { n: p.n } : {}) }));
  return { paths, dots };
}
