/**
 * OpenRouteService v2 matrix and directions API (driving-car), keyed, on api.heigit.org (api.openrouteservice.org is deprecated, 10 % quota, announced shut-off 2026-09-28). The docs site was down
 * on 2026-10-28; request/response shape verified with one live call, recorded in
 * __fixtures__/openrouteservice/matrix-marbella.json). Free Standard plan: matrix 500 and directions 2000 requests/day, 40/minute,
 * <= 3500 elements per request; the response carries `x-ratelimit-*` headers.
 * Data: © openrouteservice.org, © OpenStreetMap contributors (ODbL).
 * The key is read from `OPENROUTESERVICE_API_KEY` only here and never logged.
 */
import "server-only";
import { z } from "zod";
import { HttpError, postJson } from "./http";

export const ORS_MATRIX_URL = "https://api.heigit.org/openrouteservice/v2/matrix/driving-car";
export const ORS_DIRECTIONS_URL = "https://api.heigit.org/openrouteservice/v2/directions/driving-car/json";
/**
 * ORS error code for "no route between the two points" (HTTP 404, recorded live 2026-11-01 for Marbella → Palma
 * with ferries excluded, and for Frankfurt → London). Every other error is a failure of the lookup, not an answer.
 */
export const ORS_NO_ROUTE_CODE = 2009;
export const ORS_TIMEOUT_MS = 10_000;
/**
 * A long "no route" answer is slow: Frankfurt → London took 9.8 s in the live check (2026-11-01), against 0.1 to 0.2 s
 * for every other call. Directions gets more room so such a place is dropped as `no_road`, not counted as a failure.
 */
export const ORS_DIRECTIONS_TIMEOUT_MS = 20_000;
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

/** A ferry-free road route between two places, or the verified fact that there is none. */
export type DriveRoute = { road: true; min: number; km: number } | { road: false };

const DirectionsResponse = z.object({
  routes: z.array(z.object({ summary: z.object({ distance: z.number(), duration: z.number() }) })).min(1),
});

/**
 * Directions request with ferries excluded. A drive time over a crossing would not be one (Marbella → Palma came
 * back as 15 h); the matrix endpoint cannot exclude them (live check 2026-11-01: error 6020), so this is one request
 * per place. `geometry` and `instructions` are off: only the summary is used.
 */
export function directionsBody(from: LonLat, to: LonLat) {
  const pt = (p: LonLat) => [Number(p.lon.toFixed(5)), Number(p.lat.toFixed(5))];
  return {
    coordinates: [pt(from), pt(to)],
    units: "km",
    geometry: false,
    instructions: false,
    options: { avoid_features: ["ferries"] },
  };
}

/** Seconds/km of the first route → whole minutes (at least 1) and km (1 decimal). Throws on any other shape. */
export function parseDirections(body: unknown): { min: number; km: number } {
  const { summary } = DirectionsResponse.parse(body).routes[0];
  if (!Number.isFinite(summary.duration) || !Number.isFinite(summary.distance) || summary.duration < 0 || summary.distance < 0) {
    throw new z.ZodError([]);
  }
  return { min: Math.max(1, Math.round(summary.duration / 60)), km: Math.round(summary.distance * 10) / 10 };
}

/** True for the ORS "route could not be found" answer (404 with error.code 2009); nothing else is a negative. */
export function isNoRouteError(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 404) return false;
  const code = (err.body as { error?: { code?: unknown } } | undefined)?.error?.code;
  return code === ORS_NO_ROUTE_CODE;
}

/**
 * One ferry-free route by car. "No route" resolves to `{ road: false }`; timeouts, 5xx, quota (429), a point that
 * cannot be snapped to a road (2010) and shape errors throw, so the caller never mistakes an outage for an island.
 */
export async function fetchDriveRoute(
  from: LonLat,
  to: LonLat,
  opts: { timeoutMs?: number } = {},
): Promise<{ route: DriveRoute; status: number; latencyMs: number }> {
  const key = process.env.OPENROUTESERVICE_API_KEY?.trim();
  if (!key) throw new MissingKeyError();
  const started = Date.now();
  try {
    const r = await postJson(ORS_DIRECTIONS_URL, directionsBody(from, to), {
      timeoutMs: opts.timeoutMs ?? ORS_DIRECTIONS_TIMEOUT_MS,
      headers: { Authorization: key },
    });
    return { route: { road: true, ...parseDirections(r.body) }, status: r.status, latencyMs: r.latencyMs };
  } catch (err) {
    if (isNoRouteError(err)) return { route: { road: false }, status: 404, latencyMs: Date.now() - started };
    throw err;
  }
}
