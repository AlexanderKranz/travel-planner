import { describe, expect, it } from "vitest";
import { decodePolyline, encodePolyline, splitByWayPoints, splitPolyline, type LatLon } from "./polyline";

describe("polyline", () => {
  it("decodes the reference example (Google docs)", () => {
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
  });

  it("round-trips Wien points at 5 decimals", () => {
    const pts: LatLon[] = [
      [48.20849, 16.37208],
      [48.2066, 16.36564],
      [48.19864, 16.36302],
      [48.19152, 16.38016],
    ];
    expect(decodePolyline(encodePolyline(pts))).toEqual(pts);
    expect(encodePolyline([])).toBe("");
  });

  it("rejects a truncated string", () => {
    expect(() => decodePolyline("_p~iF~ps|U_")).toThrow();
  });

  it("splits by way_points with shared joints and re-encodes per leg", () => {
    const pts: LatLon[] = [
      [48.2, 16.3],
      [48.201, 16.301],
      [48.202, 16.302],
      [48.203, 16.303],
      [48.204, 16.304],
    ];
    expect(splitByWayPoints(pts, [0, 2, 4])).toEqual([pts.slice(0, 3), pts.slice(2, 5)]);
    const legs = splitPolyline(encodePolyline(pts), [0, 1, 4]);
    expect(legs.map((l) => decodePolyline(l))).toEqual([pts.slice(0, 2), pts.slice(1, 5)]);
    expect(() => splitByWayPoints(pts, [0, 9])).toThrow();
  });
});
