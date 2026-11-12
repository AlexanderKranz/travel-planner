import { describe, expect, it } from "vitest";
import { keepOrder, orderTour, pathSeconds, type Matrix } from "./order";
import { seededRandom } from "./test-random";

/** Random asymmetric n × n matrix; small integer ranges make many ties. */
function randomMatrix(n: number, rnd: () => number, max: number, nullRate = 0): (number | null)[][] {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : rnd() < nullRate ? null : 1 + Math.floor(rnd() * max))),
  );
}

function* permutations(items: number[]): Generator<number[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

/** Lexicographically smallest optimal order, by enumeration (permutations come in lex order). */
function bruteForce(m: Matrix, start?: number, end?: number): number[] | null {
  const n = m.length;
  const round = start !== undefined && end === start;
  let best: number[] | null = null;
  let bestCost = Infinity;
  for (const p of permutations([...Array(n).keys()])) {
    if (start !== undefined && p[0] !== start) continue;
    if (end !== undefined && !round && p[n - 1] !== end) continue;
    const seq = round ? [...p, start] : p;
    const c = pathSeconds(m, seq);
    if (c !== null && c < bestCost) {
      bestCost = c;
      best = seq;
    }
  }
  return best;
}

const CASES: { name: string; start?: number; end?: number }[] = [
  { name: "neither" },
  { name: "only start", start: 2 },
  { name: "only end", end: 5 },
  { name: "start and end", start: 1, end: 6 },
  { name: "round trip", start: 3, end: 3 },
];

describe("orderTour", () => {
  for (const c of CASES) {
    it(`matches brute force on random 8-point matrices: ${c.name}`, () => {
      const rnd = seededRandom(172 + (c.start ?? 0) * 10 + (c.end ?? 0));
      for (let t = 0; t < 15; t++) {
        // Alternate wide ranges (unique optimum) and narrow ranges (many ties).
        const m = randomMatrix(8, rnd, t % 2 ? 4 : 900);
        const r = orderTour(m, { start: c.start, end: c.end });
        expect(r).toEqual({ order: bruteForce(m, c.start, c.end) });
      }
    });
  }

  it("matches brute force with float durations (cost only)", () => {
    const rnd = seededRandom(7);
    for (let t = 0; t < 10; t++) {
      const m = randomMatrix(8, rnd, 900).map((row) => row.map((v) => (v === 0 || v === null ? v : v + rnd())));
      const r = orderTour(m, {});
      if (!("order" in r)) throw new Error("unexpected");
      expect(pathSeconds(m, r.order)).toBeCloseTo(pathSeconds(m, bruteForce(m)!)!, 6);
    }
  });

  it("avoids null edges when another order exists", () => {
    const rnd = seededRandom(99);
    for (let t = 0; t < 10; t++) {
      const m = randomMatrix(7, rnd, 50, 0.2);
      const want = bruteForce(m, 0);
      const r = orderTour(m, { start: 0 });
      if (want) expect(r).toEqual({ order: want });
      else expect("error" in r).toBe(true);
    }
  });

  it("breaks full ties by input order", () => {
    const m = Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 }, (_, j) => (i === j ? 0 : 60)));
    expect(orderTour(m, {})).toEqual({ order: [0, 1, 2, 3, 4] });
    expect(orderTour(m, { start: 3 })).toEqual({ order: [3, 0, 1, 2, 4] });
    expect(orderTour(m, { end: 0 })).toEqual({ order: [1, 2, 3, 4, 0] });
    expect(orderTour(m, { start: 2, end: 2 })).toEqual({ order: [2, 0, 1, 3, 4, 2] });
  });

  it("keep returns the input order with start first and end last", () => {
    const m = randomMatrix(5, seededRandom(1), 100);
    expect(orderTour(m, { keep: true })).toEqual({ order: [0, 1, 2, 3, 4] });
    expect(orderTour(m, { keep: true, start: 4, end: 0 })).toEqual({ order: [4, 1, 2, 3, 0] });
    expect(orderTour(m, { keep: true, start: 2, end: 2 })).toEqual({ order: [2, 0, 1, 3, 4, 2] });
    expect(keepOrder(3, { end: 0 })).toEqual([1, 2, 0]);
  });

  it("keep reports the null legs of the given order", () => {
    const m: (number | null)[][] = [
      [0, null, 5],
      [5, 0, 5],
      [5, 5, 0],
    ];
    expect(orderTour(m, { keep: true })).toEqual({ error: "unreachable", pairs: [[0, 1]] });
  });

  it("reports unreachable pairs when a point has no route at all", () => {
    const m: (number | null)[][] = [
      [0, 10, null],
      [10, 0, null],
      [null, null, 0],
    ];
    const r = orderTour(m, {});
    expect(r).toEqual({ error: "unreachable", pairs: [[0, 2], [1, 2], [2, 0], [2, 1]] });
  });

  it("handles tiny inputs and rejects too many points", () => {
    expect(orderTour([[0]], {})).toEqual({ order: [0] });
    expect(orderTour([[0]], { start: 0, end: 0 })).toEqual({ order: [0, 0] });
    expect(orderTour([[0, 3], [9, 0]], {})).toEqual({ order: [0, 1] });
    expect(orderTour([[0, 9], [3, 0]], {})).toEqual({ order: [1, 0] });
    const big = Array.from({ length: 13 }, () => Array(13).fill(1));
    expect(() => orderTour(big, {})).toThrow();
  });

  it("solves 12 points quickly", () => {
    const m = randomMatrix(12, seededRandom(12), 1800);
    const t0 = performance.now();
    const r = orderTour(m, { start: 0, end: 11 });
    expect("order" in r && r.order.length).toBe(12);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
