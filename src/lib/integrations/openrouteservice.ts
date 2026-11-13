/**
 * OpenRouteService v2 matrix and directions API (driving-car for plans and drive searches; four profiles for city
 * tours, docs checked 2026-11-12, see the tour section below), keyed, on api.heigit.org (api.openrouteservice.org is deprecated, 10 % quota, being shut off). The docs site was down
 * on 2026-10-28; request/response shape verified with one live call, recorded in
 * __fixtures__/openrouteservice/matrix-marbella.json). Free Standard plan: matrix 500 and directions 2000 requests/day, 40/minute,
 * <= 3500 elements per request; the response carries `x-ratelimit-*` headers.
 * Data: © openrouteservice.org, © OpenStreetMap contributors (ODbL).
 * The key is read from `OPENROUTESERVICE_API_KEY` only here and never logged.
 */
import "server-only";
import { z } from "zod";
import {
  MAX_TOUR_POINTS,
  ORS_PROFILE,
  ROUTE_OPTIONS_BY_MODE,
  TOUR_MODES,
  type OrsTourProfile,
  type RouteOption,
} from "@/lib/domain/tour";
import { splitPolyline } from "@/lib/tour/polyline";
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

// ---------------------------------------------------------------------------------------------------------------
// City tours (spec docs/specs/city-tour.md 5.2, 5.3 and section 14 "Spike results (2026-11-12)"). Docs checked
// 2026-11-12: https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/routing-options and
// https://giscience.github.io/openrouteservice/api-reference/endpoints/matrix/. The docs' `{ factor }` weighting
// format is rejected live (400, code 2002); plain numbers are accepted. Matrix and Directions have separate daily
// quotas (500 / 2000 per 24 h), each shared by all profiles. Recorded bodies: __fixtures__/ors-tour/.
// ---------------------------------------------------------------------------------------------------------------

/** ORS profiles of the four tour modes (spec 5.1); the domain (`ORS_PROFILE`) is the single source. */
export type { OrsTourProfile };
export const ORS_TOUR_PROFILES: readonly OrsTourProfile[] = TOUR_MODES.map((m) => ORS_PROFILE[m]);

/**
 * Options ORS accepted per profile in the spike (section 14), from the domain's `ROUTE_OPTIONS_BY_MODE`; anything
 * else is a bug and is refused before a call.
 */
export const TOUR_OPTIONS_BY_PROFILE = Object.fromEntries(
  TOUR_MODES.map((m) => [ORS_PROFILE[m], ROUTE_OPTIONS_BY_MODE[m]]),
) as Record<OrsTourProfile, readonly RouteOption[]>;

/** 25 places + start + end (spec 17.1 [P1]). ORS allows 50 waypoints and 3500 matrix elements (27 × 27 = 729). */
export const ORS_TOUR_MAX_POINTS = MAX_TOUR_POINTS;
/** ORS "could not find routable point" (HTTP 404); the message names the 0-based coordinate index. */
export const ORS_NOT_ROUTABLE_CODE = 2010;

export const orsMatrixUrl = (profile: OrsTourProfile) => `https://api.heigit.org/openrouteservice/v2/matrix/${profile}`;
export const orsDirectionsUrl = (profile: OrsTourProfile) =>
  `https://api.heigit.org/openrouteservice/v2/directions/${profile}/json`;

const lonLat = (p: LonLat) => [Number(p.lon.toFixed(5)), Number(p.lat.toFixed(5))];

function assertTourPoints(points: readonly LonLat[]): void {
  if (points.length < 2) throw new RangeError("at least two points");
  if (points.length > ORS_TOUR_MAX_POINTS) throw new RangeError("too many points");
}

/** Matrix body: every point to every point, durations only (the order needs no distances). */
export function tourMatrixBody(points: readonly LonLat[]) {
  return { locations: points.map(lonLat), metrics: ["duration"] };
}

/** n x n travel seconds (null = no connection) and how far ORS moved each point onto the network, in metres. */
export type TourMatrix = { durations: (number | null)[][]; snappedM: (number | null)[] };

const TourMatrixResponse = z.object({
  durations: z.array(z.array(z.number().nullable())),
  sources: z.array(z.object({ snapped_distance: z.number().optional() })).optional(),
});

/** Validates the n x n shape; negative or non-finite cells become null (never guessed). */
export function parseTourMatrix(body: unknown, n: number): TourMatrix {
  const m = TourMatrixResponse.parse(body);
  if (m.durations.length !== n || m.durations.some((r) => r.length !== n)) throw new z.ZodError([]);
  const durations = m.durations.map((r) => r.map((s) => (s === null || !Number.isFinite(s) || s < 0 ? null : s)));
  const snappedM = Array.from({ length: n }, (_, i) => {
    const d = m.sources?.[i]?.snapped_distance;
    return typeof d === "number" && Number.isFinite(d) ? d : null;
  });
  return { durations, snappedM };
}

/** One matrix request over the tour points (index order kept). Throws on missing key, HTTP errors, timeout, shape. */
export async function fetchMatrixFull(
  profile: OrsTourProfile,
  points: readonly LonLat[],
  opts: { timeoutMs?: number } = {},
): Promise<{ matrix: TourMatrix; status: number; latencyMs: number }> {
  const key = process.env.OPENROUTESERVICE_API_KEY?.trim();
  if (!key) throw new MissingKeyError();
  assertTourPoints(points);
  const r = await postJson(orsMatrixUrl(profile), tourMatrixBody(points), {
    timeoutMs: opts.timeoutMs ?? ORS_TIMEOUT_MS,
    headers: { Authorization: key },
  });
  return { matrix: parseTourMatrix(r.body, points.length), status: r.status, latencyMs: r.latencyMs };
}

/**
 * Directions body, exactly as the spike's table: the common part plus the option's preference and options.
 * `instructions: true` because ORS sends `segments` only with instructions; the parser drops the steps.
 */
export function tourRouteBody(points: readonly LonLat[], option: RouteOption) {
  const common = { coordinates: points.map(lonLat), geometry: true, instructions: true, elevation: false, units: "km" };
  switch (option) {
    case "fastest":
    case "shortest":
      return { ...common, options: { avoid_features: ["ferries"] }, preference: option };
    case "green":
    case "quiet":
      return {
        ...common,
        options: { avoid_features: ["ferries"], profile_params: { weightings: { [option]: 1 } } },
        preference: "recommended",
      };
    case "no_steps":
      return { ...common, options: { avoid_features: ["ferries", "steps"] }, preference: "fastest" };
    case "no_highways":
      return { ...common, options: { avoid_features: ["ferries", "highways"] }, preference: "recommended" };
  }
}

/** One leg between two consecutive points: whole minutes, km (2 decimals), encoded polyline (precision 5). */
export type OrsTourLeg = { min: number; km: number; poly: string };
/** A run's answer. `no_route` (2009) and `not_routable` (2010, 0-based point index) are facts, not failures. */
export type TourRoute =
  | { result: "ok"; legs: OrsTourLeg[] }
  | { result: "no_route" }
  | { result: "not_routable"; point: number };

const TourDirectionsResponse = z.object({
  routes: z
    .array(
      z.object({
        geometry: z.string().min(1),
        way_points: z.array(z.number().int().min(0)),
        segments: z.array(z.object({ distance: z.number().min(0), duration: z.number().min(0) })),
      }),
    )
    .min(1),
});

/**
 * Segments → legs; the polyline is cut at `way_points` (inclusive), so each leg starts and ends at the snapped
 * waypoints. Only `distance`/`duration` of a segment are read: its `steps` never reach the result or the cache.
 */
export function parseTourRoute(body: unknown, n: number): OrsTourLeg[] {
  const route = TourDirectionsResponse.parse(body).routes[0];
  if (route.segments.length !== n - 1 || route.way_points.length !== n) throw new z.ZodError([]);
  let polys: string[];
  try {
    polys = splitPolyline(route.geometry, route.way_points);
  } catch {
    throw new z.ZodError([]);
  }
  return route.segments.map((s, i) => ({
    min: Math.round(s.duration / 60),
    km: Math.round(s.distance * 100) / 100,
    poly: polys[i],
  }));
}

/**
 * One turn-by-turn step, compact (spec 17.1 [P2]): ORS `type` (0–13), street `name` ("-" = unnamed, kept as ""),
 * metres after the manoeuvre, the step's first polyline index relative to its leg, and `exit_number` on type 7.
 */
export type OrsStep = [type: number, name: string, metres: number, wp: number, exit?: number];
export type OrsTourLegSteps = OrsTourLeg & { steps: OrsStep[] };
export type TourRouteSteps =
  | { result: "ok"; legs: OrsTourLegSteps[] }
  | { result: "no_route" }
  | { result: "not_routable"; point: number };

const StepsSegments = z.object({
  routes: z
    .array(
      z.object({
        way_points: z.array(z.number().int().min(0)),
        segments: z.array(
          z.object({
            steps: z.array(
              z.object({
                type: z.number().int().min(0).max(13),
                name: z.string().optional(),
                distance: z.number().min(0),
                way_points: z.array(z.number().int().min(0)).min(1),
                exit_number: z.number().int().min(1).optional(),
              }),
            ),
          }),
        ),
      }),
    )
    .min(1),
});

/** Legs as `parseTourRoute` plus each segment's steps (ORS's English `instruction` text is dropped). */
export function parseTourRouteSteps(body: unknown, n: number): OrsTourLegSteps[] {
  const legs = parseTourRoute(body, n);
  const route = StepsSegments.parse(body).routes[0];
  return legs.map((leg, i) => ({
    ...leg,
    steps: route.segments[i].steps.map((st): OrsStep => {
      const name = !st.name || st.name === "-" ? "" : st.name.slice(0, 120);
      const metres = Math.round(st.distance * 1000);
      const wp = Math.max(0, st.way_points[0] - route.way_points[i]);
      return st.type === 7 && st.exit_number ? [st.type, name, metres, wp, st.exit_number] : [st.type, name, metres, wp];
    }),
  }));
}

/** 0-based coordinate index from a 2010 answer ("... of specified coordinate 1: 13.46 48.57 ..."), or null. */
export function notRoutablePoint(err: unknown, n: number): number | null {
  if (!(err instanceof HttpError) || err.status !== 404) return null;
  const e = (err.body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
  if (e?.code !== ORS_NOT_ROUTABLE_CODE || typeof e.message !== "string") return null;
  const m = /coordinate (\d+)/.exec(e.message);
  const i = m ? Number(m[1]) : NaN;
  return Number.isInteger(i) && i >= 0 && i < n ? i : null;
}

/**
 * One Directions request for a run of legs with the same profile and option. 2009 → `no_route`, 2010 with a point
 * index → `not_routable`. Everything else (400/2002 = a bug in the body, 429, 5xx, timeout, shape, a 2010 without a
 * readable index) throws, so the caller reports `failed` and never mistakes an outage for an unreachable place.
 */
export async function fetchRoute(
  profile: OrsTourProfile,
  points: readonly LonLat[],
  option: RouteOption,
  opts: { timeoutMs?: number } = {},
): Promise<{ route: TourRoute; status: number; latencyMs: number }> {
  return requestRoute(profile, points, option, opts, parseTourRoute);
}

/** As `fetchRoute`, keeping the steps: only for "Wegbeschreibung" on request (spec 17.1 [P2]). */
export async function fetchRouteSteps(
  profile: OrsTourProfile,
  points: readonly LonLat[],
  option: RouteOption,
  opts: { timeoutMs?: number } = {},
): Promise<{ route: TourRouteSteps; status: number; latencyMs: number }> {
  return requestRoute(profile, points, option, opts, parseTourRouteSteps);
}

async function requestRoute<L extends OrsTourLeg>(
  profile: OrsTourProfile,
  points: readonly LonLat[],
  option: RouteOption,
  opts: { timeoutMs?: number },
  parse: (body: unknown, n: number) => L[],
): Promise<{ route: { result: "ok"; legs: L[] } | { result: "no_route" } | { result: "not_routable"; point: number }; status: number; latencyMs: number }> {
  const key = process.env.OPENROUTESERVICE_API_KEY?.trim();
  if (!key) throw new MissingKeyError();
  assertTourPoints(points);
  if (!TOUR_OPTIONS_BY_PROFILE[profile].includes(option)) throw new RangeError(`option ${option} not offered for ${profile}`);
  const started = Date.now();
  try {
    const r = await postJson(orsDirectionsUrl(profile), tourRouteBody(points, option), {
      timeoutMs: opts.timeoutMs ?? ORS_DIRECTIONS_TIMEOUT_MS,
      headers: { Authorization: key },
    });
    return { route: { result: "ok", legs: parse(r.body, points.length) }, status: r.status, latencyMs: r.latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - started;
    if (isNoRouteError(err)) return { route: { result: "no_route" }, status: 404, latencyMs };
    const point = notRoutablePoint(err, points.length);
    if (point !== null) return { route: { result: "not_routable", point }, status: 404, latencyMs };
    throw err;
  }
}
