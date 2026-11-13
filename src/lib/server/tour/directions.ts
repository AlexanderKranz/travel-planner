"use server";

import { z } from "zod";
import type { ActionError } from "@/lib/domain/result";
import { ORS_PROFILE } from "@/lib/domain/tour";
import type { OrsStep } from "@/lib/integrations/openrouteservice";
import { groupRuns } from "@/lib/tour/runs";
import { legChanged } from "@/lib/tour/steps";
import { tourPointsOf } from "@/lib/tour/points";
import { logEvent } from "../events";
import { orsTourGate } from "../facts/ors-quota";
import { getTourSteps } from "../facts/tour-ors";
import { rateLimit } from "../rate-limit";
import { getUserSession } from "../session";
import { rowToTour, TOUR_COLUMNS, type TourRow } from "./mapping";

/**
 * "Wegbeschreibung" (spec 17.1 [P2]): turn-by-turn steps for a computed tour, only when the viewer asks. One
 * Directions request per run of the stored result (cached 90 d under `tour-steps`), never stored in the tour.
 * Steps and GPX come from this answer; the stored result stays the source for times, checks, map and PDF. A leg whose
 * distance differs from the stored one by more than 5 % or 50 m is flagged `changed` ("Tour neu berechnen").
 * Owner and read grantees (anyone who can read the tour through RLS) may ask.
 */

export type DirectionsLeg = { steps: OrsStep[]; poly: string; km: number; changed: boolean } | null;
export type TourDirections = { legs: DirectionsLeg[]; fetchedAt: string; stale: boolean };
export type TourDirectionsResult =
  | { ok: true; data: TourDirections }
  | { ok: false; error: ActionError | "not_computed"; retryAfter?: number };

const Id = z.string().uuid();
const PER_MIN = 6;
const PER_HOUR = 30;
const fail = (error: ActionError | "not_computed", retryAfter?: number): TourDirectionsResult => ({
  ok: false,
  error,
  ...(retryAfter ? { retryAfter } : {}),
});

export async function getTourDirections(id: string): Promise<TourDirectionsResult> {
  try {
    return await run(id);
  } catch {
    return fail("failed");
  }
}

async function run(id: string): Promise<TourDirectionsResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  if (!Id.safeParse(id).success) return fail("invalid");

  const { data: row, error } = await session.supabase.from("city_tours").select(TOUR_COLUMNS).eq("id", id).maybeSingle<TourRow>();
  if (error) return fail("failed");
  if (!row) return fail("not_found");
  const tour = rowToTour(row, session.userId);
  if (!tour) return fail("invalid");
  const result = tour.result;
  if (!result || tour.outdated || result.legs.length === 0) return fail("not_computed");

  const minute = rateLimit(`tour-directions:${session.userId}`, PER_MIN, 60_000);
  if (!minute.ok) return fail("rate_limited", minute.retryAfterSeconds);
  const hour = rateLimit(`tour-directions-h:${session.userId}`, PER_HOUR, 3_600_000);
  if (!hour.ok) return fail("rate_limited", hour.retryAfterSeconds);

  const byKey = new Map(tourPointsOf(tour.input).points.map((p) => [p.key, p]));
  const runs = groupRuns(result.legs.map(({ from, to, mode, route }) => ({ from, to, mode, route })));
  if (runs.some((r) => r.points.some((k) => !byKey.has(k)))) return fail("not_computed");
  if (!(await orsTourGate(runs.length, { needsMatrix: false }))) return fail("ors_unavailable");

  const ctx = { userId: session.userId };
  const answers = await Promise.all(
    runs.map((r) => getTourSteps(ORS_PROFILE[r.mode], r.route, r.points.map((k) => byKey.get(k)!), ctx)),
  );
  const legs: DirectionsLeg[] = result.legs.map(() => null);
  const dates: string[] = [];
  let stale = false;
  let cacheHits = 0;
  for (const [ri, runOf] of runs.entries()) {
    const a = answers[ri];
    if (a.result === "failed") continue;
    dates.push(a.fetchedAt);
    stale ||= a.stale;
    cacheHits += a.cache === "hit" ? 1 : 0;
    if (a.result !== "ok") continue;
    for (const [j, li] of runOf.legs.entries()) {
      const leg = a.legs[j];
      legs[li] = { steps: leg.steps, poly: leg.poly, km: leg.km, changed: legChanged(result.legs[li].km, leg.km) };
    }
  }
  if (legs.every((l) => l === null)) return fail("ors_unavailable");

  await logEvent({
    event: "tour.directions",
    userId: session.userId,
    props: { legs: legs.length, runs: runs.length, cacheHits, failedLegs: legs.filter((l) => l === null).length },
  });
  return { ok: true, data: { legs, fetchedAt: [...dates].sort()[0], stale } };
}
