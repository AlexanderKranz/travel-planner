import { describe, expect, it, vi } from "vitest";

// Spy on orderTour as the proposals module calls it (same module instance), real implementation underneath.
vi.mock("./order", async (orig) => {
  const m = await orig<typeof import("./order")>();
  return { ...m, orderTour: vi.fn(m.orderTour) };
});

import { orderTour } from "./order";
import { overProposals } from "./proposals";
import { seededRandom } from "./test-random";

function cityMatrix(n: number, rnd: () => number): number[][] {
  const pts = Array.from({ length: n }, () => [rnd() * 4000, rnd() * 4000]);
  return pts.map((a, i) => pts.map((b, j) => (i === j ? 0 : Math.round(Math.hypot(a[0] - b[0], a[1] - b[1]) / 1.3))));
}

describe("drop proposals on a large tour", () => {
  it("run every drop search with the quick effort and still propose drops", () => {
    const n = 25;
    const m = cityMatrix(n, seededRandom(25));
    const order = [...Array(n).keys()];
    const res = overProposals({
      m,
      keys: order.map((i) => `osm:n${i}`),
      dwell: order.map(() => 30),
      order,
      keep: false,
      totalMin: 2000,
      maxMin: 600,
      dwellDefaultMin: 30,
    });
    const calls = vi.mocked(orderTour).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(n - 2); // one per droppable place
    expect(calls.every(([, opts]) => opts.quick === true)).toBe(true);
    expect(res.some((p) => p.kind === "drop")).toBe(true);
  });
});
