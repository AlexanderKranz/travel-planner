import { describe, expect, it } from "vitest";
import { decodeInts, decodePolyline, encodeInts, encodePolyline, splitPolyline, type LatLon } from "./polyline";

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
    const ll: LatLon[] = [[48.2, 16.3], [48.201, 16.301], [48.202, 16.302], [48.203, 16.303], [48.204, 16.304]];
    expect(splitPolyline(encodePolyline(ll), [0, 1, 4]).map((l) => decodePolyline(l))).toEqual([ll.slice(0, 2), ll.slice(1, 5)]);
  });

  it("rejects malformed input and bad cuts", () => {
    expect(() => decodeInts("_p~iF~ps|")).toThrow(RangeError); // truncated mid-value
    expect(() => decodePolyline("_p~iF~ps|U_")).toThrow(RangeError);
    expect(() => decodeInts(" ")).toThrow(RangeError);
    const s = encodeInts([[0, 0], [1, 1]]);
    expect(() => splitPolyline(s, [0])).toThrow(RangeError);
    expect(() => splitPolyline(s, [0, 2])).toThrow(RangeError);
    expect(() => splitPolyline(s, [1, 0])).toThrow(RangeError);
  });
});
