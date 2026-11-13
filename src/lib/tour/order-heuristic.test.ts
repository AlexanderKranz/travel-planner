import { describe, expect, it } from "vitest";
import { EXACT_MAX_POINTS, orderTour, pathSeconds, type Matrix } from "./order";
import { heuristicOrder } from "./order-heuristic";
import { seededRandom } from "./test-random";

/** City-like matrix: points in a 4 × 4 km box, walking seconds with a detour factor and a little asymmetry. */
function cityMatrix(n: number, rnd: () => number, nullAt: number[] = []): (number | null)[][] {
  const pts = Array.from({ length: n }, () => [rnd() * 4000, rnd() * 4000]);
  return pts.map((a, i) =>
    pts.map((b, j) => {
      if (i === j) return 0;
      if (nullAt.includes(i) || nullAt.includes(j)) return null;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      return Math.round((d * (1.25 + rnd() * 0.1)) / 1.3);
    }),
  );
}

const CASES: { name: string; start?: number; end?: number }[] = [
  { name: "neither" },
  { name: "only start", start: 0 },
  { name: "only end", end: 3 },
  { name: "start and end", start: 1, end: 4 },
  { name: "round trip", start: 2, end: 2 },
];

function valid(seq: number[], n: number, start?: number, end?: number) {
  const round = start !== undefined && end === start;
  expect(seq.length).toBe(round ? n + 1 : n);
  expect(new Set(seq).size).toBe(n);
  if (start !== undefined) expect(seq[0]).toBe(start);
  if (end !== undefined) expect(seq.at(-1)).toBe(end);
}

describe("heuristicOrder", () => {
  it.each(CASES)("stays within 1 % of the exact order on 14-point cities ($name)", ({ start, end }) => {
    const rnd = seededRandom(1405);
    for (let k = 0; k < 15; k++) {
      const m = cityMatrix(14, rnd);
      const exact = orderTour(m, { start, end });
      const h = heuristicOrder(m, { start, end });
      if (!("order" in exact) || !h) throw new Error("unexpected");
      valid(h, 14, start, end);
      expect(pathSeconds(m, h)!).toBeLessThanOrEqual(pathSeconds(m, exact.order)! * 1.01);
    }
  });

  it.each(CASES)("orders 27 points validly and quickly ($name)", ({ start, end }) => {
    const m = cityMatrix(27, seededRandom(27));
    const t0 = performance.now();
    const r = orderTour(m, { start, end });
    expect(performance.now() - t0).toBeLessThan(500);
    if (!("order" in r)) throw new Error("unexpected");
    expect(r.exact).toBe(false);
    valid(r.order, 27, start, end);
  });

  it("is deterministic", () => {
    const m = cityMatrix(25, seededRandom(7));
    expect(heuristicOrder(m, { start: 0 })).toEqual(heuristicOrder(m, { start: 0 }));
  });

  it("uses the heuristic only above the exact limit", () => {
    const at = orderTour(cityMatrix(EXACT_MAX_POINTS, seededRandom(3)), {});
    const above = orderTour(cityMatrix(EXACT_MAX_POINTS + 1, seededRandom(3)), {});
    expect("order" in at && at.exact).toBe(true);
    expect("order" in above && above.exact).toBe(false);
  });

  it("reports a point without routes as unreachable", () => {
    const m: Matrix = cityMatrix(20, seededRandom(9), [5]);
    const r = orderTour(m, {});
    expect("error" in r && r.pairs.some(([a, b]) => a === 5 || b === 5)).toBe(true);
  });

  it("drop proposals over 25 places stay fast (n quick heuristic calls)", () => {
    const m = cityMatrix(25, seededRandom(11));
    const t0 = performance.now();
    for (let drop = 0; drop < 25; drop++) {
      const keep = [...Array(25).keys()].filter((i) => i !== drop);
      orderTour(keep.map((i) => keep.map((j) => m[i][j])), { quick: true });
    }
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("exact limit stays fast for the drop proposals (16 calls at 15 points)", () => {
    const m = cityMatrix(16, seededRandom(13));
    const t0 = performance.now();
    for (let drop = 0; drop < 16; drop++) {
      const keep = [...Array(16).keys()].filter((i) => i !== drop);
      orderTour(keep.map((i) => keep.map((j) => m[i][j])), {});
    }
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
