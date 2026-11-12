/**
 * Encoded polylines (Google format, as ORS returns with `geometry: true`, 2D, precision 5). Pure.
 * Points are `[lat, lon]` tuples.
 */
export type LatLon = [number, number];

export function decodePolyline(s: string, precision = 5): LatLon[] {
  const f = 10 ** precision;
  const out: LatLon[] = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = (): number => {
    let shift = 0;
    let result = 0;
    let b: number;
    do {
      if (i >= s.length) throw new Error("decodePolyline: truncated");
      b = s.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) {
    lat += next();
    lon += next();
    out.push([lat / f, lon / f]);
  }
  return out;
}

function encodeValue(v: number): string {
  let x = v < 0 ? ~(v << 1) : v << 1;
  let out = "";
  while (x >= 0x20) {
    out += String.fromCharCode((0x20 | (x & 0x1f)) + 63);
    x >>= 5;
  }
  return out + String.fromCharCode(x + 63);
}

export function encodePolyline(points: readonly LatLon[], precision = 5): string {
  const f = 10 ** precision;
  let pLat = 0;
  let pLon = 0;
  let out = "";
  for (const [la, lo] of points) {
    const lat = Math.round(la * f);
    const lon = Math.round(lo * f);
    out += encodeValue(lat - pLat) + encodeValue(lon - pLon);
    pLat = lat;
    pLon = lon;
  }
  return out;
}

/**
 * Split a route's points by ORS `way_points` (indices of the waypoints in the geometry) into one array per leg.
 * Leg i covers points `way_points[i]..way_points[i + 1]` inclusive, so neighbouring legs share their joint point.
 */
export function splitByWayPoints<T>(points: readonly T[], wayPoints: readonly number[]): T[][] {
  const legs: T[][] = [];
  for (let i = 0; i + 1 < wayPoints.length; i++) {
    const a = wayPoints[i];
    const b = wayPoints[i + 1];
    if (a < 0 || b < a || b >= points.length) throw new Error("splitByWayPoints: bad way_points");
    legs.push(points.slice(a, b + 1));
  }
  return legs;
}

/** Decode a run's polyline and re-encode it per leg (the stored `TourLeg.poly`). */
export function splitPolyline(encoded: string, wayPoints: readonly number[]): string[] {
  return splitByWayPoints(decodePolyline(encoded), wayPoints).map((leg) => encodePolyline(leg));
}
