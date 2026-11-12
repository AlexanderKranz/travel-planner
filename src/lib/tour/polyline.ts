/**
 * Encoded polyline (Google format), as returned by ORS with `geometry: true` and `elevation: false`: 2D, `[lat, lon]`
 * order, precision 5 (spike 2026-11-12, spec city-tour section 14). Pure and dependency-free.
 *
 * Points are handled as integers (degrees x 10^precision) internally, so decoding, slicing and re-encoding a leg is
 * lossless: `encode(decode(s)) === s` for every valid input.
 */

export type LatLon = [lat: number, lon: number];

const factorOf = (precision: number) => 10 ** precision;

/** Decodes to integer pairs (degrees x 10^precision). Throws on a truncated or malformed string. */
export function decodeInts(encoded: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (i >= encoded.length) throw new RangeError("truncated polyline");
      byte = encoded.charCodeAt(i++) - 63;
      if (byte < 0 || byte > 63) throw new RangeError("invalid polyline character");
      result |= (byte & 0x1f) << shift;
      shift += 5;
      if (shift > 30) throw new RangeError("polyline value too large");
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    lat += next();
    lon += next();
    out.push([lat, lon]);
  }
  return out;
}

/** Encodes integer pairs (degrees x 10^precision). */
export function encodeInts(points: readonly (readonly [number, number])[]): string {
  let out = "";
  const put = (v: number) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  let lat = 0;
  let lon = 0;
  for (const [a, b] of points) {
    put(a - lat);
    put(b - lon);
    lat = a;
    lon = b;
  }
  return out;
}

export function decodePolyline(encoded: string, precision = 5): LatLon[] {
  const f = factorOf(precision);
  return decodeInts(encoded).map(([a, b]) => [a / f, b / f]);
}

export function encodePolyline(points: readonly LatLon[], precision = 5): string {
  const f = factorOf(precision);
  return encodeInts(points.map(([a, b]) => [Math.round(a * f), Math.round(b * f)]));
}

/**
 * Splits a route polyline into one polyline per leg at the given point indices (ORS `way_points`): leg i is points
 * `cuts[i]..cuts[i+1]` inclusive, so neighbouring legs share their waypoint. Throws when the indices are not
 * increasing or fall outside the polyline.
 */
export function splitPolyline(encoded: string, cuts: readonly number[]): string[] {
  const pts = decodeInts(encoded);
  if (cuts.length < 2) throw new RangeError("need at least two cut points");
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i];
    if (!Number.isInteger(c) || c < 0 || c >= pts.length) throw new RangeError("cut outside polyline");
    if (i > 0 && c < cuts[i - 1]) throw new RangeError("cuts not increasing");
  }
  const legs: string[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) legs.push(encodeInts(pts.slice(cuts[i], cuts[i + 1] + 1)));
  return legs;
}
