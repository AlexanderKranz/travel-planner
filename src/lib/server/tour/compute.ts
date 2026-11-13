"use server";

import { z } from "zod";
import type { Locale } from "@/lib/domain/profile";
import type { ActionError } from "@/lib/domain/result";
import {
  legPolyCap,
  ORS_PROFILE,
  TOUR_COMPUTES_PER_DAY,
  TOUR_COMPUTES_PER_MIN,
  TourResult,
  type TourInput,
  type TourLeg,
  type TourPoint,
} from "@/lib/domain/tour";
import { MAX_LANDMARKS } from "@/lib/facts/landmarks";
import { getPlaceById } from "@/lib/integrations/open-meteo-geocoding";
import { tourInputHash } from "@/lib/tour/hash";
import { keepOrder, orderTour } from "@/lib/tour/order";
import { tourCentre, tourPointsOf, type TourPoints } from "@/lib/tour/points";
import { decodePolyline } from "@/lib/tour/polyline";
import { overProposals, type TourProposal } from "@/lib/tour/proposals";
import { groupRuns, plannedLegs, pruneOverrides } from "@/lib/tour/runs";
import { sightsNearRoute } from "@/lib/tour/sights";
import { effectiveMaxMin, stopTimes, sunsetWarning, tourFit, tourTotalMin, type StopTime } from "@/lib/tour/timing";
import { berlinMidnight } from "../ai-usage";
import { releaseAiCall, reserveAiCall } from "../ai-slots";
import { logEvent } from "../events";
import { orsTourGate } from "../facts/ors-quota";
import { getTourMatrix, getTourRoute, peekTourMatrix, type TourRouteAnswer } from "../facts/tour-ors";
import { rateLimit } from "../rate-limit";
import { getUserSession } from "../session";
import { createSupabaseAdminClient } from "../supabase/admin";
import { rowToTour, TOUR_COLUMNS, type TourRow } from "./mapping";
import { cityDestination, cityPlaces } from "./places";
import { GEO_KEY } from "./resolve";

/**
 * computeTour (docs/specs/city-tour.md section 11, steps 1–6). Owner only. Every number in the result comes from ORS
 * (matrix, Directions), OSM (cached city places) or arithmetic; nothing is guessed. The result is written with the
 * secret key after the row was read through RLS (the `group_parsed` pattern): users have no grant on `result`,
 * `result_hash` and `computed_at`, so a direct PostgREST call cannot plant a fake "verified" route [T14].
 *
 * Limits: 10 per minute in memory, plus 10 per minute and 20 per Berlin day per user held durably in `ai_call_slots`
 * (task `tour_compute`; atomic across instances, no content). An unchanged input costs nothing and takes no slot.
 */

export type ComputedTour = {
  result: TourResult;
  /** The stored result was returned: the input did not change since it was computed (0 ORS calls). */
  unchanged: boolean;
  /** Leg settings that no longer apply after the re-order (shown once, spec 3.2). */
  droppedOverrides: number;
  /** City places were not cached: sights follow in a later computation (retry job queued). */
  sightsPending: boolean;
  /** Only when the tour is over its limit: up to 3 approximate options (spec 7). */
  proposals: TourProposal[];
  /** Arrive/leave per stop of `result.order` when the tour has a start time and every leg has a time. */
  stopTimes: StopTime[] | null;
  /** Minutes over the max or free below the min (with `result.fit`). */
  byMin: number | null;
  /** New `updatedAt` of the row (the server write moves it). */
  updatedAt: string;
};

export type ComputeTourResult =
  | { ok: true; data: ComputedTour }
  | {
      ok: false;
      error: ActionError;
      /** `ors_unavailable`: the stored result, shown with "nicht neu berechnet". */
      result?: TourResult | null;
      notRecomputed?: true;
      /** `unreachable`: point keys the tour mode cannot reach. */
      points?: string[];
      retryAfter?: number;
      resetAt?: string;
    };

const Id = z.string().uuid();

type Fail = Extract<ComputeTourResult, { ok: false }>;
const err = (error: ActionError, extra: Omit<Fail, "ok" | "error"> = {}): Fail => ({ ok: false, error, ...extra });

async function profileLocale(session: NonNullable<Awaited<ReturnType<typeof getUserSession>>>): Promise<Locale> {
  const { data } = await session.supabase.from("profiles").select("locale").eq("id", session.userId).maybeSingle();
  return data?.locale === "en" ? "en" : "de";
}

/** Points that cause the unreachable pairs: a point ORS cannot route has a full null row and column. */
function flaggedKeys(points: readonly TourPoint[], pairs: [number, number][]): string[] {
  const n = points.length;
  const count = new Array<number>(n).fill(0);
  for (const [a, b] of pairs) {
    count[a]++;
    count[b]++;
  }
  // A point in every pair with all others (row + column, 2(n−1) cells) is the culprit; else all points involved.
  const isolated = count.map((c, i) => (c >= 2 * (n - 1) ? i : -1)).filter((i) => i >= 0);
  const idx = isolated.length ? isolated : [...new Set(pairs.flat())];
  return [...new Set(idx.map((i) => points[i].key))];
}

/** Upper bound of Directions runs before the order is known: each override can split a run in two. */
function runsBound(tp: TourPoints, overrides: number): number {
  const legs = tp.points.length - 1 + (tp.end !== undefined && tp.end === tp.start ? 1 : 0);
  return Math.max(1, Math.min(legs, 2 * overrides + 1));
}

async function cityTimeZone(input: TourInput, locale: Locale): Promise<string | null> {
  const m = input.city ? GEO_KEY.exec(input.city.key) : null;
  if (!m) return null;
  try {
    return (await getPlaceById(Number(m[1]), locale))?.timezone ?? null;
  } catch {
    return null;
  }
}

/** Writes the snapshot with the SECRET KEY; scoped to the row read through RLS (id + owner + unchanged updated_at). */
async function saveResult(row: TourRow, result: TourResult, hash: string): Promise<{ updatedAt: string } | null> {
  try {
    const { data, error } = await createSupabaseAdminClient()
      .from("city_tours")
      .update({ result, result_hash: hash, computed_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("owner_id", row.owner_id)
      .eq("updated_at", row.updated_at)
      .select("updated_at");
    if (error || !data || data.length !== 1) return null;
    return { updatedAt: (data[0] as { updated_at: string }).updated_at };
  } catch {
    return null;
  }
}

const maxFrom = (input: TourInput) => effectiveMaxMin(input);

function timesOf(input: TourInput, result: TourResult, dwellByKey: Map<string, number>): StopTime[] | null {
  if (!input.startTime) return null;
  const dwell = result.order.map((k, i) => (i === result.order.length - 1 && i > 0 && k === result.order[0] ? 0 : (dwellByKey.get(k) ?? 0)));
  return stopTimes(input.startTime, result.legs.map((l) => l.min), dwell);
}

function dwellMap(tp: TourPoints): Map<string, number> {
  return new Map(tp.points.map((p, i) => [p.key, tp.dwell[i]]));
}

/** Proposals for an over-limit tour from a given or peeked (cache-only) matrix; 0 API calls. */
async function proposalsFor(
  input: TourInput,
  tp: TourPoints,
  result: TourResult,
  matrix: (number | null)[][] | null,
): Promise<TourProposal[]> {
  const maxMin = maxFrom(input);
  if (result.fit !== "over" || result.totalMin === null || maxMin === undefined) return [];
  const m = matrix ?? (await peekTourMatrix(ORS_PROFILE[input.mode], tp.points))?.durations ?? null;
  const idx = new Map(tp.points.map((p, i) => [p.key, i]));
  const order = result.order.map((k, i) => (i > 0 && i === result.order.length - 1 && k === result.order[0] ? tp.start! : idx.get(k)!));
  return overProposals({
    m,
    keys: tp.points.map((p) => p.key),
    dwell: tp.dwell,
    start: tp.start,
    end: tp.end,
    order,
    keep: input.order === "keep",
    totalMin: result.totalMin,
    maxMin,
    dwellDefaultMin: input.dwellDefaultMin,
  });
}

export async function computeTour(id: string): Promise<ComputeTourResult> {
  try {
    return await run(id);
  } catch {
    return err("failed"); // an unexpected error (all clients and caches return errors as data)
  }
}

async function run(id: string): Promise<ComputeTourResult> {
  const session = await getUserSession();
  if (!session) return err("unauthenticated");
  if (!Id.safeParse(id).success) return err("invalid");

  // 1. Load through RLS; owner only (grantees of a linked trip can read, not compute).
  const { data: row, error: readError } = await session.supabase
    .from("city_tours")
    .select(TOUR_COLUMNS)
    .eq("id", id)
    .maybeSingle<TourRow>();
  if (readError) return err("failed");
  if (!row) return err("not_found");
  if (row.owner_id !== session.userId) return err("forbidden");
  const tour = rowToTour(row, session.userId);
  if (!tour) return err("invalid");
  const input = tour.input;
  const tp = tourPointsOf(input);
  const locale = await profileLocale(session);
  const ctx = { userId: session.userId };

  // 2. Unchanged input → the stored result, no ORS call and no slot.
  const hash = tourInputHash(input);
  // A stored result with a failed leg (ORS down then) is recomputed, so a transient outage is not kept forever.
  if (tour.result && row.result_hash === hash && !tour.result.legs.some((l) => l.s === "failed")) {
    let result = tour.result;
    let updatedAt = row.updated_at;
    let sightsPending = false;
    if (result.sights.length === 0) {
      // Sights may have been pending at the last computation: try the city places from the cache only (no call).
      const s = await sightsFor(input, tp, result.legs, locale, session.userId, false);
      sightsPending = s.pending;
      if (s.sights.length) {
        const next = TourResult.parse({ ...result, sights: s.sights, source: { ...result.source, ...(s.fetchedAt ? { osm: s.fetchedAt } : {}) } });
        const saved = await saveResult(row, next, hash);
        if (saved) {
          result = next;
          updatedAt = saved.updatedAt;
        }
      }
    }
    const fit = tourFit(result.totalMin, input.minMin, maxFrom(input));
    return {
      ok: true,
      data: {
        result,
        unchanged: true,
        droppedOverrides: 0,
        sightsPending,
        proposals: await proposalsFor(input, tp, result, null),
        stopTimes: timesOf(input, result, dwellMap(tp)),
        byMin: fit.byMin ?? null,
        updatedAt,
      },
    };
  }

  // 3. Rate limits: per minute in memory, per minute and per Berlin day durably (fails closed).
  const minute = rateLimit(`tour-compute:${session.userId}`, TOUR_COMPUTES_PER_MIN, 60_000);
  if (!minute.ok) return err("rate_limited", { retryAfter: minute.retryAfterSeconds });
  const now = new Date();
  let slotId: string;
  try {
    const slot = await reserveAiCall({
      userId: session.userId,
      task: "tour_compute",
      perMinute: TOUR_COMPUTES_PER_MIN,
      perDay: TOUR_COMPUTES_PER_DAY,
      dayStart: berlinMidnight(now),
    });
    if (!slot.ok) {
      return slot.reason === "day"
        ? err("daily_limit", { resetAt: berlinMidnight(now, 1).toISOString() })
        : err("rate_limited", { retryAfter: 60 });
    }
    slotId = slot.id;
  } catch {
    return err("failed");
  }

  // 4. ORS gate: matrix above the plan reserve (not for "keep"), one Directions request per run.
  const keep = input.order === "keep";
  const overrideCount = Object.keys(input.legOverrides ?? {}).length;
  const unavailable = () => err("ors_unavailable", { result: tour.result, notRecomputed: true });
  if (!(await orsTourGate(runsBound(tp, overrideCount), { needsMatrix: !keep }))) {
    await releaseAiCall(slotId); // nothing was computed: the slot does not count
    return unavailable();
  }

  // 5a. Order: one matrix + Held–Karp, or the user's order.
  let cacheHits = 0;
  let stale = false;
  const orsDates: string[] = [];
  let matrix: (number | null)[][] | null = null;
  let order: number[];
  let orderApprox = false;
  if (keep) {
    order = keepOrder(tp.points.length, { start: tp.start, end: tp.end });
  } else {
    const m = await getTourMatrix(ORS_PROFILE[input.mode], tp.points, ctx);
    if (!m) {
      await releaseAiCall(slotId); // no matrix (key missing, quota, ORS down): nothing computed, the slot does not count
      return unavailable();
    }
    matrix = m.durations;
    cacheHits += m.cache === "hit" ? 1 : 0;
    stale ||= m.stale;
    orsDates.push(m.fetchedAt);
    const o = orderTour(m.durations, { start: tp.start, end: tp.end });
    if ("error" in o) return err("unreachable", { points: flaggedKeys(tp.points, o.pairs) });
    order = o.order;
    orderApprox = !o.exact;
  }
  const keys = order.map((i) => tp.points[i].key);
  const byKey = new Map(tp.points.map((p) => [p.key, p]));

  // 5b. Legs and runs; one Directions request per run.
  const { kept, dropped } = pruneOverrides(input.legOverrides ?? {}, keys);
  const planned = plannedLegs(keys, { mode: input.mode, route: input.route }, kept);
  const runs = groupRuns(planned);
  const answers: TourRouteAnswer[] = await Promise.all(
    runs.map((r) => getTourRoute(ORS_PROFILE[r.mode], r.route, r.points.map((k) => byKey.get(k)!), ctx)),
  );
  const legs: TourLeg[] = planned.map((l) => ({ ...l, min: null, km: null, poly: null, s: "failed" }));
  const notRoutable: string[] = [];
  // Leg lines share one budget, so 26 long legs keep the snapshot under the 256 kB result check (spec 17.1 [P1]).
  const polyCap = legPolyCap(planned.length);
  runs.forEach((run, ri) => {
    const a = answers[ri];
    if (a.result === "not_routable") notRoutable.push(run.points[a.point]);
    if (a.result !== "failed") {
      cacheHits += a.cache === "hit" ? 1 : 0;
      stale ||= a.stale;
      orsDates.push(a.fetchedAt);
    }
    run.legs.forEach((li, j) => {
      if (a.result === "ok") {
        const leg = a.legs[j];
        // A leg geometry above the snapshot limit keeps its time and distance, without the line.
        legs[li] = { ...legs[li], min: leg.min, km: leg.km, poly: leg.poly && leg.poly.length <= polyCap ? leg.poly : null, s: "ok" };
      } else if (a.result === "no_route") legs[li] = { ...legs[li], s: "no_route" };
    });
  });
  // A place ORS cannot route (2010) is flagged like an unreachable matrix pair: nothing is computed or stored.
  if (notRoutable.length) return err("unreachable", { points: [...new Set(notRoutable)] });

  // 5c. Timing.
  const dwellByKey = dwellMap(tp);
  const stopDwell = keys.map((k, i) => (i > 0 && i === keys.length - 1 && k === keys[0] ? 0 : (dwellByKey.get(k) ?? 0)));
  const totalMin = tourTotalMin(legs.map((l) => l.min), stopDwell);
  const fit = tourFit(totalMin, input.minMin, maxFrom(input));
  const sunset = sunsetWarning({
    date: input.date,
    startTime: input.startTime,
    totalMin,
    centre: tourCentre(input, tp.points),
    timeZone: input.date && input.startTime ? await cityTimeZone(input, locale) : null,
  });

  // 5d. Sights: cached city places only (Geoapify fast path allowed, never Overpass).
  const s = await sightsFor(input, tp, legs, locale, session.userId, true);

  const result = TourResult.parse({
    v: 1,
    order: keys,
    legs,
    totalMin,
    fit: fit.fit,
    ...(sunset ? { sunset } : {}),
    sights: s.sights,
    source: { ors: orsDates.length ? [...orsDates].sort()[0] : now.toISOString(), ...(s.fetchedAt ? { osm: s.fetchedAt } : {}) },
    ...(stale ? { stale: true } : {}),
    ...(orderApprox ? { orderApprox: true } : {}),
  });

  // 6. Snapshot with the secret key, then the event (no names, no coordinates).
  const saved = await saveResult(row, result, hash);
  if (!saved) return err("conflict"); // the tour changed (or was deleted) meanwhile: reload and compute again
  const failedLegs = legs.filter((l) => l.s !== "ok").length;
  await logEvent({
    event: "tour.computed",
    userId: session.userId,
    props: { points: tp.points.length, mode: input.mode, route: input.route, runs: runs.length, cacheHits, fit: fit.fit, failedLegs },
  });
  return {
    ok: true,
    data: {
      result,
      unchanged: false,
      droppedOverrides: dropped,
      sightsPending: s.pending,
      proposals: await proposalsFor(input, tp, result, matrix),
      stopTimes: timesOf(input, result, dwellByKey),
      byMin: fit.byMin ?? null,
      updatedAt: saved.updatedAt,
    },
  };
}

/** Sights near the legs from the city places around the city (or the first place). */
async function sightsFor(
  input: TourInput,
  tp: TourPoints,
  legs: readonly TourLeg[],
  locale: Locale,
  userId: string,
  network: boolean,
) {
  const anchor = input.city ?? input.places[0];
  const found = await cityPlaces(cityDestination(anchor), ["general"], { userId, locale, network, limit: MAX_LANDMARKS });
  const lines = legs.map((l) => {
    try {
      return { mode: l.mode, line: l.poly ? decodePolyline(l.poly) : null };
    } catch {
      return { mode: l.mode, line: null };
    }
  });
  return {
    sights: sightsNearRoute(found.places, lines, tp.points.map((p) => p.key)),
    pending: found.pending,
    fetchedAt: found.fetchedAt,
  };
}
