import { describe, expect, it } from "vitest";
import { sightsNearRoute, type SightCandidate, type SightLeg } from "./sights";

// Two legs in Wien: west–east along 48.200, then north along 16.380.
const legs: SightLeg[] = [
  { mode: "foot", line: [[48.2, 16.36], [48.2, 16.38]] },
  { mode: "foot", line: [[48.2, 16.38], [48.21, 16.38]] },
];
// 0.001° lat ≈ 111 m; 0.001° lon at 48.2° ≈ 74 m.
const cand = (key: string, lat: number, lon: number): SightCandidate => ({ key, name: key, lat, lon, cat: "museum" });

describe("sightsNearRoute", () => {
  it("keeps candidates within the corridor and assigns the nearest leg", () => {
    const out = sightsNearRoute(
      [cand("osm:n1", 48.201, 16.37), cand("osm:n2", 48.205, 16.381), cand("osm:n3", 48.203, 16.37)],
      legs,
      [],
    );
    expect(out.map((s) => [s.key, s.leg, s.m])).toEqual([
      ["osm:n1", 0, 111],
      ["osm:n2", 1, 74],
    ]);
  });

  it("excludes tour points and duplicate keys", () => {
    const c = cand("osm:n1", 48.2005, 16.37);
    expect(sightsNearRoute([c, c, cand("osm:n9", 48.2005, 16.371)], legs, ["osm:n9"]).map((s) => s.key)).toEqual([
      "osm:n1",
    ]);
  });

  it("caps 3 per leg and 8 per tour in rank order", () => {
    const onLeg0 = Array.from({ length: 5 }, (_, i) => cand(`a${i}`, 48.2002, 16.362 + i * 0.003));
    expect(sightsNearRoute(onLeg0, legs, []).map((s) => s.key)).toEqual(["a0", "a1", "a2"]);
    const many: SightLeg[] = Array.from({ length: 4 }, (_, i) => ({
      mode: "foot",
      line: [[48.2 + i * 0.01, 16.36], [48.2 + i * 0.01, 16.38]],
    }));
    const cands = many.flatMap((_, i) => [0, 1, 2].map((k) => cand(`l${i}k${k}`, 48.2 + i * 0.01, 16.365 + k * 0.004)));
    const out = sightsNearRoute(cands, many, []);
    expect(out).toHaveLength(8);
    expect(out.map((s) => s.key)).toEqual(cands.slice(0, 8).map((c) => c.key));
  });

  it("uses the corridor of the leg mode and skips failed legs", () => {
    const far = cand("osm:n5", 48.2025, 16.37); // ~278 m from leg 0
    expect(sightsNearRoute([far], legs, [])).toEqual([]);
    expect(sightsNearRoute([far], [{ ...legs[0], mode: "cycling" }], [])).toHaveLength(1);
    expect(sightsNearRoute([far], [{ mode: "car", line: null }], [])).toEqual([]);
  });
});
