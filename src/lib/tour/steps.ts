/**
 * Turn-by-turn sentences from compact ORS steps (spec 17.1 [P2]). Pure: returns message keys and values for
 * `tours.steps.*` (rule 5), so one ORS answer serves every locale.
 *
 * ORS step types: 0 left, 1 right, 2 sharp left, 3 sharp right, 4 slight left, 5 slight right, 6 straight,
 * 7 enter roundabout, 8 exit roundabout, 9 U-turn, 10 goal, 11 depart, 12 keep left, 13 keep right.
 * Type 8 is merged into the type 7 sentence (it adds nothing the exit number does not say).
 */
import type { OrsStep } from "@/lib/integrations/openrouteservice";

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

/** The on-request route differs from the stored leg: more than 5 % or 50 m in distance (whichever is larger). */
export function legChanged(storedKm: number | null, freshKm: number): boolean {
  if (storedKm === null) return false;
  return Math.abs(storedKm - freshKm) > Math.max(0.05 * storedKm, 0.05);
}
