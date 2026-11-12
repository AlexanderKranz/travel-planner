import { describe, expect, it } from "vitest";
import { groupRuns, plannedLegs, pruneOverrides } from "./runs";

const order = ["s", "a", "b", "c", "d"];
const def = { mode: "foot", route: "fastest" } as const;

describe("runs", () => {
  it("one run without overrides", () => {
    const runs = groupRuns(plannedLegs(order, def));
    expect(runs).toEqual([{ mode: "foot", route: "fastest", legs: [0, 1, 2, 3], points: order }]);
  });

  it("splits at overrides and merges equal neighbours", () => {
    const legs = plannedLegs(order, def, {
      "a>b": { mode: "foot", route: "green" },
      "b>c": { mode: "foot", route: "green" },
      "c>d": { mode: "foot", route: "fastest" }, // equal to the default: same run as nothing
      "x>y": { mode: "car", route: "fastest" }, // not a leg
    });
    expect(legs.map((l) => l.route)).toEqual(["fastest", "green", "green", "fastest"]);
    expect(groupRuns(legs)).toEqual([
      { mode: "foot", route: "fastest", legs: [0], points: ["s", "a"] },
      { mode: "foot", route: "green", legs: [1, 2], points: ["a", "b", "c"] },
      { mode: "foot", route: "fastest", legs: [3], points: ["c", "d"] },
    ]);
  });

  it("splits on mode with the same route", () => {
    const legs = plannedLegs(["a", "b", "c"], def, { "b>c": { mode: "cycling", route: "fastest" } });
    expect(groupRuns(legs).map((r) => r.mode)).toEqual(["foot", "cycling"]);
    expect(groupRuns([])).toEqual([]);
  });

  it("keeps overrides whose places stay neighbours and counts the dropped ones", () => {
    const o = {
      "a>b": { mode: "foot", route: "green" },
      "b>c": { mode: "car", route: "fastest" },
      "c>d": { mode: "cycling", route: "quiet" },
    } as const;
    // New order: s, b, a, d, c → a–b neighbours (reversed), c–d neighbours (reversed), b–c not.
    const r = pruneOverrides(o, ["s", "b", "a", "d", "c"]);
    expect(r).toEqual({
      kept: { "b>a": { mode: "foot", route: "green" }, "d>c": { mode: "cycling", route: "quiet" } },
      dropped: 1,
    });
    expect(pruneOverrides(o, order)).toEqual({ kept: o, dropped: 0 });
    expect(pruneOverrides({ junk: { mode: "foot", route: "fastest" } }, order).dropped).toBe(1);
  });
});
