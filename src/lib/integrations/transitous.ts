import "server-only";
import { z } from "zod";
import { TRANSIT_MAX_PARTS, type TransitPart } from "@/lib/domain/tour";
import { pointToSegmentM } from "@/lib/tour/geo";
import { decodePolyline, encodePolyline, type LatLon } from "@/lib/tour/polyline";
import { localHhmm } from "@/lib/tour/zoned";
import { fetchJson } from "./http";

/**
 * Transitous journey planning (MOTIS 2, `GET /api/v6/plan`) for one public transport leg of a city tour
 * (docs/specs/city-tour.md 17.1 [P3], 17.4). Terms (transitous.org/api, read 2026-11-13): open-source and
 * non-commercial use only, a User-Agent with app name, version and contact on every request, a visible link to
 * https://transitous.org/sources/. Best effort: failures are answers of the caller ("unavailable"), never a guess.
 */
export const TRANSITOUS_PLAN_URL = "https://api.transitous.org/api/v6/plan";
export const TRANSITOUS_SOURCES_URL = "https://transitous.org/sources/";
export const TRANSITOUS_TIMEOUT_MS = 8000;
export const TRANSITOUS_USER_AGENT = "travel-planner/0.1.0 (+https://github.com/AlexanderKranz/travel-planner)";

const Place = z.object({ name: z.string().optional() });
const Leg = z.object({
  mode: z.string(),
  from: Place,
  to: Place,
  startTime: z.string(),
  endTime: z.string(),
  displayName: z.string().optional(),
  routeShortName: z.string().optional(),
  headsign: z.string().optional(),
  agencyName: z.string().optional(),
  intermediateStops: z.array(z.unknown()).optional(),
  legGeometry: z.object({ points: z.string(), precision: z.number().int().min(1).max(7).optional() }).optional(),
});
const Itinerary = z.object({ startTime: z.string(), endTime: z.string(), legs: z.array(Leg).min(1) });
const PlanResponse = z.object({ itineraries: z.array(Itinerary), direct: z.array(Itinerary).optional() });

/** One leg's answer, compact (no intermediate stops, no raw geometry): what the tour result stores. */
export type TransitAnswer =
  | { kind: "ok"; min: number; km: number; poly: string; parts: TransitPart[] }
  | { kind: "walk_not_slower"; min: number; km: number; poly: string }
  | { kind: "no_connection" };

export function planUrl(from: { lat: number; lon: number }, to: { lat: number; lon: number }, isoWithOffset: string): string {
  const q = new URLSearchParams({
    fromPlace: `${from.lat.toFixed(5)},${from.lon.toFixed(5)}`,
    toPlace: `${to.lat.toFixed(5)},${to.lon.toFixed(5)}`,
    time: isoWithOffset,
  });
  return `${TRANSITOUS_PLAN_URL}?${q.toString()}`;
}

function lineOf(legs: readonly z.infer<typeof Leg>[]): LatLon[] {
  const out: LatLon[] = [];
  for (const l of legs) {
    if (!l.legGeometry) continue;
    const pts = decodePolyline(l.legGeometry.points, l.legGeometry.precision ?? 6);
    out.push(...(out.length && pts.length ? pts.slice(1) : pts));
  }
  return out;
}

function lineKm(line: readonly LatLon[]): number {
  let m = 0;
  for (let i = 1; i < line.length; i++) m += pointToSegmentM({ lat: line[i][0], lon: line[i][1] }, line[i - 1], line[i - 1]);
  return Math.round(m / 10) / 100;
}

const minutes = (fromMs: number, toIso: string) => Math.max(0, Math.round((Date.parse(toIso) - fromMs) / 60000));

/**
 * The first itinerary departing at or after `departUtcMs`; its minutes are arrival minus the requested departure, so
 * the wait at the stop counts (spec 17.4). When the direct walk is not slower, walking is kept and said so.
 */
export function pickConnection(body: unknown, departUtcMs: number, timeZone: string): TransitAnswer {
  const plan = PlanResponse.parse(body);
  const best = plan.itineraries
    .filter((it) => Date.parse(it.startTime) >= departUtcMs && it.legs.some((l) => l.mode !== "WALK"))
    .sort((a, b) => Date.parse(a.endTime) - Date.parse(b.endTime) || Date.parse(a.startTime) - Date.parse(b.startTime))[0];
  const walk = plan.direct?.find((it) => it.legs.every((l) => l.mode === "WALK"));
  const walkMin = walk ? Math.round((Date.parse(walk.endTime) - Date.parse(walk.startTime)) / 60000) : null;
  const bestMin = best ? minutes(departUtcMs, best.endTime) : null;

  if (walk && walkMin !== null && (bestMin === null || walkMin <= bestMin)) {
    const line = lineOf(walk.legs);
    return { kind: "walk_not_slower", min: walkMin, km: lineKm(line), poly: line.length > 1 ? encodePolyline(line) : "" };
  }
  if (!best || bestMin === null) return { kind: "no_connection" };

  const parts: TransitPart[] = best.legs.slice(0, TRANSIT_MAX_PARTS).map((l) => {
    const walking = l.mode === "WALK";
    return {
      m: walking ? "walk" : l.mode.slice(0, 20),
      ...(!walking && (l.displayName ?? l.routeShortName) ? { line: (l.displayName ?? l.routeShortName)!.slice(0, 40) } : {}),
      ...(!walking && l.headsign ? { head: l.headsign.slice(0, 80) } : {}),
      ...(!walking && l.agencyName ? { agency: l.agencyName.slice(0, 80) } : {}),
      from: (l.from.name ?? "").slice(0, 120),
      to: (l.to.name ?? "").slice(0, 120),
      dep: localHhmm(Date.parse(l.startTime), timeZone),
      arr: localHhmm(Date.parse(l.endTime), timeZone),
      ...(!walking && l.intermediateStops ? { stops: Math.min(200, l.intermediateStops.length + 1) } : {}),
    };
  });
  const line = lineOf(best.legs);
  return { kind: "ok", min: bestMin, km: lineKm(line), poly: line.length > 1 ? encodePolyline(line) : "", parts };
}

/** One `/plan` request. Throws on HTTP errors, timeouts and shapes; `pickConnection` turns the body into an answer. */
export async function fetchPlan(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  departure: { utcMs: number; iso: string },
  timeZone: string,
): Promise<{ answer: TransitAnswer; status: number; latencyMs: number }> {
  const r = await fetchJson(planUrl(from, to, departure.iso), {
    timeoutMs: TRANSITOUS_TIMEOUT_MS,
    headers: { "User-Agent": TRANSITOUS_USER_AGENT },
  });
  return { answer: pickConnection(r.body, departure.utcMs, timeZone), status: r.status, latencyMs: r.latencyMs };
}
