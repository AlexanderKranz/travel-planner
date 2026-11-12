import { describe, expect, it } from "vitest";
import { haversineKm } from "@/lib/facts/places";
import { pointToPolylineM, pointToSegmentM } from "./geo";

// Wien: a west–east segment along latitude 48.2.
const a: [number, number] = [48.2, 16.36];
const b: [number, number] = [48.2, 16.38];

describe("geo", () => {
  it("measures the perpendicular distance to a segment", () => {
    const p = { lat: 48.201, lon: 16.37 }; // ~111 m north of the middle
    expect(pointToSegmentM(p, a, b)).toBeCloseTo(haversineKm(p, { lat: 48.2, lon: 16.37 }) * 1000, 0);
  });

  it("measures to the nearer end beyond the segment", () => {
    const p = { lat: 48.2, lon: 16.39 };
    expect(pointToSegmentM(p, a, b)).toBeCloseTo(haversineKm(p, { lat: b[0], lon: b[1] }) * 1000, -1);
  });

  it("handles a degenerate segment and a polyline", () => {
    const p = { lat: 48.2009, lon: 16.36 };
    expect(pointToSegmentM(p, a, a)).toBeCloseTo(100, -1);
    const line: [number, number][] = [a, b, [48.21, 16.38]];
    expect(pointToPolylineM({ lat: 48.205, lon: 16.381 }, line)).toBeCloseTo(74, -1);
    expect(pointToPolylineM(p, [a])).toBeCloseTo(100, -1);
    expect(pointToPolylineM(p, [])).toBe(Infinity);
  });
});
