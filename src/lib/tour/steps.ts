/**
 * Turn-by-turn sentences from compact ORS steps (spec 17.1 [P2]). Pure: returns message keys and values for
 * `tours.steps.*` (rule 5), so one ORS answer serves every locale.
 *
 * ORS step types: 0 left, 1 right, 2 sharp left, 3 sharp right, 4 slight left, 5 slight right, 6 straight,
 * 7 enter roundabout, 8 exit roundabout, 9 U-turn, 10 goal, 11 depart, 12 keep left, 13 keep right.
 * Type 8 is merged into the type 7 sentence (it adds nothing the exit number does not say).
 */
import type { OrsStep } from "@/lib/integrations/openrouteservice";
import { pointToPolylineM } from "./geo";
import { decodePolyline } from "./polyline";

const KEYS: Record<number, string> = {
  0: "left",
  1: "right",
  2: "sharpLeft",
  3: "sharpRight",
  4: "slightLeft",
  5: "slightRight",
  6: "straight",
  7: "roundabout",
  9: "uturn",
  10: "arrive",
  11: "depart",
  12: "keepLeft",
  13: "keepRight",
};

/** One line: `key` under `tours.steps`, `values` for it; `metres` to show after the sentence (0 = none). */
export type StepLine = { key: string; values: Record<string, string | number>; metres: number };

export function stepLines(steps: readonly OrsStep[]): StepLine[] {
  const out: StepLine[] = [];
  for (const [type, name, metres, , exit] of steps) {
    if (type === 8) continue;
    const base = KEYS[type];
    if (!base) continue;
    let key = base;
    if (type === 7 && !exit) key = "roundaboutNoExit";
    // "Links abbiegen in Domgasse" / "Links abbiegen": the street only when ORS names one.
    const onto = name ? "Onto" : "";
    const values: Record<string, string | number> = { name };
    if (type === 7 && exit) values.exit = exit;
    out.push({ key: `${key}${type === 10 ? "" : onto}`, values, metres: type === 10 ? 0 : metres });
  }
  return out;
}

/** Geometry tolerance: an on-request point farther than this from the stored line means another path. */
export const CHANGED_OFF_ROUTE_M = 50;

/**
 * The on-request route differs from the stored leg (spec 17.4): distance by more than 5 % or 50 m (whichever is
 * larger), or the lines are more than 50 m apart in either direction (a new point far from the stored line, or a
 * stored point far from the new line: a dropped detour counts too). Without a stored line only the distance counts.
 */
export function legChanged(stored: { km: number | null; poly: string | null }, fresh: { km: number; poly: string }): boolean {
  if (stored.km !== null && Math.abs(stored.km - fresh.km) > Math.max(0.05 * stored.km, 0.05)) return true;
  if (!stored.poly) return false;
  const old = decodePolyline(stored.poly);
  const now = decodePolyline(fresh.poly);
  if (old.length < 2 || now.length < 2) return false;
  const off = (pts: typeof old, line: typeof old) => pts.some(([lat, lon]) => pointToPolylineM({ lat, lon }, line) > CHANGED_OFF_ROUTE_M);
  return off(now, old) || off(old, now);
}

/**
 * Identity of a stored result for the directions view: order, each leg's mode, option, km and line, and the route
 * source date (a recomputation that only moves a line or refreshes ORS changes it too). A short FNV-1a hash, so the
 * page sends a few characters, not the polylines. Pure (browser and server).
 */
export function resultVersion(r: {
  order: readonly string[];
  legs: readonly { mode: string; route: string; km: number | null; poly?: string | null }[];
  source?: { ors?: string };
}): string {
  const text = `${r.order.join("|")}#${r.legs.map((l) => `${l.mode}:${l.route}:${l.km ?? "-"}:${l.poly ?? ""}`).join("|")}#${r.source?.ors ?? ""}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, "0")}-${text.length.toString(36)}`;
}
