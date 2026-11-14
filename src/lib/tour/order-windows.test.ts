import { describe, expect, it } from "vitest";
import { orderTourWithWindows } from "./order";
import { evaluate, exactWindowOrder, type WindowTiming } from "./order-windows";
import { seededRandom } from "./test-random";

const H = 3600;
function matrix(n: number, rnd: () => number): number[][] {
  const pts = Array.from({ length: n }, () => [rnd() * 3000, rnd() * 3000]);
  return pts.map((a, i) => pts.map((b, j) => (i === j ? 0 : Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) * 1.3))));
}
function* perms(items: number[]): Generator<number[]> {
  if (items.length <= 1) return yield [...items];
  for (let i = 0; i < items.length; i++) for (const p of perms([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i], ...p];
}
/** Best on-time finish by enumeration (start fixed at 0, open end). */
function brute(m: number[][], t: WindowTiming): number | null {
  let best: number | null = null;
  for (const p of perms([...Array(m.length).keys()].slice(1))) {
    const e = evaluate(m, t, [0, ...p], false);
    if (e.late === 0 && (best === null || e.finish < best)) best = e.finish;
  }
  return best;
}

describe("time windows (spec 17.4)", () => {
  it("exact order matches enumeration on random 7-point tours with windows", () => {
    const rnd = seededRandom(17);
    for (let k = 0; k < 20; k++) {
      const m = matrix(7, rnd);
      const win = m.map((_, i) => (i > 0 && rnd() < 0.5 ? { after: 10 * H + Math.round(rnd() * 2 * H), before: 12 * H + Math.round(rnd() * 3 * H) } : undefined));
      const t: WindowTiming = { startSec: 10 * H, dwellSec: m.map((_, i) => (i ? 1800 : 0)), win };
      const want = brute(m, t);
      const got = exactWindowOrder(m, t, { start: 0 });
      if (want === null) expect(got).toBeNull();
      else expect(evaluate(m, t, got!, false)).toMatchObject({ late: 0, finish: want });
    }
  });

  it("waits for a later opening instead of missing it, and visits a deadline stop first", () => {
    // 0 start; 1 must start by 10:30; 2 not before 11:00. Travel 10 min each, dwell 30 min.
    const m = [[0, 600, 600], [600, 0, 600], [600, 600, 0]];
    const t: WindowTiming = { startSec: 10 * H, dwellSec: [0, 1800, 1800], win: [undefined, { before: 10.5 * H }, { after: 11 * H }] };
    const r = orderTourWithWindows(m, { start: 0 }, t);
    expect(r).toEqual({ order: [0, 1, 2], exact: true });
  });

  it("no on-time order: keeps every stop and reports the late ones", () => {
    const m = [[0, 3600, 3600], [3600, 0, 3600], [3600, 3600, 0]];
    const t: WindowTiming = { startSec: 10 * H, dwellSec: [0, 1800, 1800], win: [undefined, { before: 10.5 * H }, { before: 10.5 * H }] };
    const r = orderTourWithWindows(m, { start: 0 }, t);
    if (!("order" in r)) throw new Error("unexpected");
    expect(new Set(r.order)).toEqual(new Set([0, 1, 2]));
    expect(r.exact).toBe(false);
    expect(r.lateAt?.length).toBe(2);
  });

  it("27 points with windows: valid, deterministic and quick", () => {
    const rnd = seededRandom(27);
    const m = matrix(27, rnd);
    const win = m.map((_, i) => (i % 5 === 1 ? { after: 11 * H } : i % 7 === 2 ? { before: 13 * H } : undefined));
    const t: WindowTiming = { startSec: 9 * H, dwellSec: m.map(() => 900), win };
    const t0 = performance.now();
    const a = orderTourWithWindows(m, { start: 0 }, t);
    expect(performance.now() - t0).toBeLessThan(5000);
    if (!("order" in a)) throw new Error("unexpected");
    expect(new Set(a.order).size).toBe(27);
    expect(a.order[0]).toBe(0);
    expect(orderTourWithWindows(m, { start: 0 }, t)).toEqual(a);
  });

  it("without windows it is the plain order", () => {
    const m = matrix(6, seededRandom(3));
    const t: WindowTiming = { startSec: 9 * H, dwellSec: m.map(() => 0), win: m.map(() => undefined) };
    expect(orderTourWithWindows(m, { start: 0 }, t)).toMatchObject({ exact: true });
  });
});
