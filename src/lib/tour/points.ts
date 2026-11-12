/**
 * The matrix point list of a tour: `[start?, ...places, end?]`. `end: "start"` is a round trip (end index = start
 * index); an explicit end with the start key is treated the same. Pure.
 */
import type { TourInput, TourPoint } from "@/lib/domain/tour";

export type TourPoints = {
  points: TourPoint[];
  /** Index of the start in `points`. */
  start?: number;
  /** Index of the end; equals `start` for a round trip. */
  end?: number;
  /** Dwell minutes per point index: places use their own value or the tour default, start and end 0. */
  dwell: number[];
};

export function tourPointsOf(input: Pick<TourInput, "places" | "start" | "end" | "dwellDefaultMin">): TourPoints {
  const points: TourPoint[] = [];
  const dwell: number[] = [];
  let start: number | undefined;
  let end: number | undefined;
  if (input.start) {
    start = 0;
    points.push(input.start);
    dwell.push(0);
  }
  for (const p of input.places) {
    points.push(p);
    dwell.push(p.dwellMin ?? input.dwellDefaultMin);
  }
  const e = input.end;
  if (e === "start" || (e && start !== undefined && e.key === input.start?.key)) end = start;
  else if (e && typeof e === "object") {
    end = points.length;
    points.push(e);
    dwell.push(0);
  }
  return { points, start, end, dwell };
}

/** Centre of the tour for the sunset check: the city when set, else the mean of the points. */
export function tourCentre(
  input: Pick<TourInput, "city">,
  points: readonly { lat: number; lon: number }[],
): { lat: number; lon: number } | null {
  if (input.city) return { lat: input.city.lat, lon: input.city.lon };
  if (!points.length) return null;
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lon = points.reduce((s, p) => s + p.lon, 0) / points.length;
  return { lat, lon };
}
