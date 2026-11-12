import { describe, expect, it } from "vitest";
import { decodeInts, decodePolyline, encodeInts, encodePolyline, splitPolyline } from "./polyline";

describe("polyline (precision 5, [lat, lon])", () => {
  it("decodes and encodes the reference example from the format description", () => {
    // Google's documented example: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453).
    const s = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
    expect(decodePolyline(s)).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
    expect(encodePolyline(decodePolyline(s))).toBe(s);
  });

  it("round-trips integers losslessly, including zero steps and negatives", () => {
    const pts: [number, number][] = [[4820850, 1637310], [4820850, 1637310], [-100, 5], [0, 0], [-1, -1]];
    expect(decodeInts(encodeInts(pts))).toEqual(pts);
    expect(encodeInts([])).toBe("");
  });

  it("splits at cut indices, inclusive, so neighbouring legs share the waypoint", () => {
    const pts: [number, number][] = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]];
    const legs = splitPolyline(encodeInts(pts), [0, 2, 4]);
    expect(legs.map(decodeInts)).toEqual([
      [[0, 0], [1, 1], [2, 2]],
      [[2, 2], [3, 3], [4, 4]],
    ]);
  });

  it("rejects malformed input and bad cuts", () => {
    expect(() => decodeInts("_p~iF~ps|")).toThrow(RangeError); // truncated mid-value
    expect(() => decodeInts(" ")).toThrow(RangeError);
    const s = encodeInts([[0, 0], [1, 1]]);
    expect(() => splitPolyline(s, [0])).toThrow(RangeError);
    expect(() => splitPolyline(s, [0, 2])).toThrow(RangeError);
    expect(() => splitPolyline(s, [1, 0])).toThrow(RangeError);
  });
});
