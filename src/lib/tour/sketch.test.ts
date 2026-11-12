import { describe, expect, it } from "vitest";
import { encodePolyline } from "./polyline";
import { SKETCH_HEIGHT, SKETCH_WIDTH, sketchGeometry } from "./sketch";

const a = { lat: 48.2085, lon: 16.3731 };
const b = { lat: 48.2065, lon: 16.3655 };
const c = { lat: 48.199, lon: 16.363 };

describe("sketchGeometry", () => {
  it("projects legs and points into the box, north up", () => {
    const g = sketchGeometry({
      legs: [{ poly: encodePolyline([[a.lat, a.lon], [b.lat, b.lon]]) }, { poly: encodePolyline([[b.lat, b.lon], [c.lat, c.lon]]), dashed: true }],
      points: [{ ...a, n: 1 }, { ...b, n: 2 }, { ...c, n: 3 }],
    });
    expect([g.width, g.height]).toEqual([SKETCH_WIDTH, SKETCH_HEIGHT]);
    expect(g.paths.map((p) => [p.leg, p.dashed])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(g.paths[0].d.startsWith("M")).toBe(true);
    for (const p of g.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(g.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(g.height);
    }
    // c is the southernmost point: largest y. a is the easternmost: largest x.
    const [pa, , pc] = g.points;
    expect(pc.y).toBeGreaterThan(pa.y);
    expect(pa.x).toBeGreaterThan(pc.x);
    expect(g.points.map((p) => p.n)).toEqual([1, 2, 3]);
  });

  it("leaves out legs without a usable polyline and survives a broken one", () => {
    const g = sketchGeometry({ legs: [{ poly: null }, { poly: "@@@@\u0000" }], points: [a, b] });
    expect(g.paths).toEqual([]);
    expect(g.points).toHaveLength(2);
  });

  it("is empty without any geometry and honours the size", () => {
    expect(sketchGeometry({ legs: [], points: [], width: 100, height: 50 })).toEqual({ width: 100, height: 50, paths: [], points: [] });
  });

  it("handles a single point (zero span)", () => {
    const g = sketchGeometry({ legs: [], points: [a] });
    expect(Number.isFinite(g.points[0].x) && Number.isFinite(g.points[0].y)).toBe(true);
  });
});
