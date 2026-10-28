import type { PlanFlights } from "@/lib/domain/plan";

type Leg = PlanFlights["legs"][number];

/** Legs grouped by direction and route, in the order out → back, then by departure. */
export function flightGroups(legs: Leg[]): { dir: Leg["dir"]; from: string; to: string; legs: Leg[] }[] {
  const out: { dir: Leg["dir"]; from: string; to: string; legs: Leg[] }[] = [];
  for (const dir of ["out", "back"] as const) {
    for (const l of legs.filter((x) => x.dir === dir).sort((a, b) => a.dep.localeCompare(b.dep))) {
      const g = out.find((x) => x.dir === dir && x.from === l.from && x.to === l.to);
      if (g) g.legs.push(l);
      else out.push({ dir, from: l.from, to: l.to, legs: [l] });
    }
  }
  return out;
}
