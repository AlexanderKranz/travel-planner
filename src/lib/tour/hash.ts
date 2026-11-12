/**
 * Tour hashes (docs/specs/city-tour.md section 11). Pure, node crypto as in `src/lib/plan/hash.ts`.
 */
import { createHash } from "node:crypto";
import type { TourInput, TourPoint } from "@/lib/domain/tour";
import { canonicalJson } from "@/lib/plan/hash";

/** Bump when the computation changes so stored results count as outdated. */
export const TOUR_HASH_VERSION = 1;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** What of a point affects the result: identity, position (5 dp) and dwell. Name, source and category do not. */
const pt = (p: TourPoint) => ({ key: p.key, lat: r5(p.lat), lon: r5(p.lon), dwell: p.dwellMin });

/**
 * sha256 hex of the normalized input that produces a `TourResult` (`city_tours.result_hash`). The title is left out
 * (renaming does not recompute); key order of objects does not matter (`canonicalJson`).
 */
export function tourInputHash(i: TourInput): string {
  return sha256(
    canonicalJson({
      v: TOUR_HASH_VERSION,
      city: i.city ? pt(i.city) : null,
      places: i.places.map(pt),
      start: i.start ? pt(i.start) : null,
      end: i.end === "start" ? "start" : i.end ? pt(i.end) : null,
      order: i.order,
      mode: i.mode,
      route: i.route,
      legOverrides: i.legOverrides ?? {},
      date: i.date ?? null,
      startTime: i.startTime ?? null,
      endBy: i.endBy ?? null,
      minMin: i.minMin ?? null,
      maxMin: i.maxMin ?? null,
      dwellDefaultMin: i.dwellDefaultMin,
    }),
  );
}

type KeyedPoint = Pick<TourPoint, "key" | "lat" | "lon">;
/** `[key, lat, lon]` (5 dp) as JSON: unambiguous whatever characters the key holds. */
const keyAt = (p: KeyedPoint) => JSON.stringify([p.key, p.lat.toFixed(5), p.lon.toFixed(5)]);

/** Matrix cache `h`: sha256 of the sorted points (key, lat, lon at 5 dp); the same point set in any order hits. */
export function pointSetHash(points: readonly KeyedPoint[]): string {
  return sha256(`[${points.map(keyAt).sort().join(",")}]`);
}

/** Directions cache `h`: sha256 of the ordered points (key, lat, lon at 5 dp). */
export function pointSeqHash(points: readonly KeyedPoint[]): string {
  return sha256(`[${points.map(keyAt).join(",")}]`);
}
