/**
 * OpenRouteService v2 matrix API (driving-car), keyed. https://api.openrouteservice.org (the docs site was down
 * on 2026-10-28; request/response shape verified with one live call, recorded in
 * __fixtures__/openrouteservice/matrix-marbella.json). Free Standard plan: matrix ~500 requests/day,
 * <= 3500 elements per request; the response carries `x-ratelimit-*` headers (limit 50 seen).
 * Data: © openrouteservice.org, © OpenStreetMap contributors (ODbL).
 * The key is read from `OPENROUTESERVICE_API_KEY` only here and never logged.
 */
import "server-only";
import { z } from "zod";
import { postJson } from "./http";

export const ORS_MATRIX_URL = "https://api.openrouteservice.org/v2/matrix/driving-car";
export const ORS_TIMEOUT_MS = 10_000;
/** One source × N destinations; far below the 3500-element limit on purpose. */
export const ORS_MAX_DESTINATIONS = 60;
/**
 * Longer "drives" are dropped [D6]: ORS routes over ferries (Marbella → Palma came back as 15 h / 925 km),
 * which is not a usable day-trip time.
 */
export const MAX_DRIVE_MIN = 180;

export type LonLat = { lat: number; lon: number };
export type Drive = { min: number; km: number };

const row = z.array(z.number().nullable());
const MatrixResponse = z.object({
  durations: z.array(row).length(1),
  distances: z.array(row).length(1),
});

/** Request body: index 0 = origin, 1..N = destinations (ORS expects [lon, lat]). */
export function matrixBody(origin: LonLat, dests: readonly LonLat[]) {
  const pt = (p: LonLat) => [Number(p.lon.toFixed(5)), Number(p.lat.toFixed(5))];
  return {
    locations: [pt(origin), ...dests.map(pt)],
    sources: [0],
    destinations: dests.map((_, i) => i + 1),
    metrics: ["duration", "distance"],
    units: "km",
  };
}

/**
 * Seconds/km → whole minutes and km (1 decimal), one entry per destination. Null (unreachable), non-finite
 * or implausible values become null: the caller omits them, never guesses.
 */
export function parseMatrix(body: unknown, expected: number): (Drive | null)[] {
  const m = MatrixResponse.parse(body);
  const dur = m.durations[0];
  const dist = m.distances[0];
  if (dur.length !== expected || dist.length !== expected) throw new z.ZodError([]);
  return dur.map((s, i) => {
    const km = dist[i];
    if (s === null || km === null || !Number.isFinite(s) || !Number.isFinite(km) || s < 0 || km < 0) return null;
    const min = Math.max(1, Math.round(s / 60));
    if (min > MAX_DRIVE_MIN) return null;
    return { min, km: Math.round(km * 10) / 10 };
  });
}

export class MissingKeyError extends Error {
  constructor() {
    super("OPENROUTESERVICE_API_KEY missing");
    this.name = "MissingKeyError";
  }
}

/** One matrix request: origin → each destination by car. Throws on HTTP/timeout/shape errors. */
export async function fetchDriveMatrix(
  origin: LonLat,
  dests: readonly LonLat[],
  opts: { timeoutMs?: number } = {},
): Promise<{ drives: (Drive | null)[]; status: number; latencyMs: number }> {
  const key = process.env.OPENROUTESERVICE_API_KEY?.trim();
  if (!key) throw new MissingKeyError();
  if (dests.length === 0) return { drives: [], status: 200, latencyMs: 0 };
  if (dests.length > ORS_MAX_DESTINATIONS) throw new RangeError("too many destinations");
  const r = await postJson(ORS_MATRIX_URL, matrixBody(origin, dests), {
    timeoutMs: opts.timeoutMs ?? ORS_TIMEOUT_MS,
    headers: { Authorization: key },
  });
  return { drives: parseMatrix(r.body, dests.length), status: r.status, latencyMs: r.latencyMs };
}
