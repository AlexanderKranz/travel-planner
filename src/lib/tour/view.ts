/**
 * What the tour page shows next to a stored result, derived by code (spec 7): arrive/leave times per stop and the
 * minutes over or under the limit. The same arithmetic as `computeTour`, for a page load without a computation.
 * Pure; imported by server components only (timing pulls in the daylight helpers).
 */
import type { TourInput, TourResult } from "@/lib/domain/tour";
import { tourPointsOf } from "./points";
import { effectiveMaxMin, stopTimes, tourFit, type StopTime } from "./timing";

export type TourView = { stopTimes: StopTime[] | null; byMin: number | null };

export function tourView(input: TourInput, result: TourResult | null): TourView {
  if (!result) return { stopTimes: null, byMin: null };
  const tp = tourPointsOf(input);
  const dwellByKey = new Map(tp.points.map((p, i) => [p.key, tp.dwell[i]]));
  const last = result.order.length - 1;
  const dwell = result.order.map((k, i) => (i > 0 && i === last && k === result.order[0] ? 0 : (dwellByKey.get(k) ?? 0)));
  const times = input.startTime && dwell.length ? stopTimes(input.startTime, result.legs.map((l) => l.min), dwell) : null;
  const fit = tourFit(result.totalMin, input.minMin, effectiveMaxMin(input));
  return { stopTimes: times, byMin: fit.byMin ?? null };
}
