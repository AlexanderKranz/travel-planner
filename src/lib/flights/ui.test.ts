import { describe, expect, it } from "vitest";
import found from "./__fixtures__/flights-fact-found.json";
import mixed from "./__fixtures__/flights-fact-mixed.json";
import proxy from "./__fixtures__/flights-fact-proxy.json";
import type { FlightsFacts } from "@/lib/domain/flights";
import type { ResolvedEntry } from "@/lib/group";
import { adultsFromEntries, durationParts, fittingLegs, legsOfPair, limitHours, pairState } from "./ui";

const d = (f: unknown) => (f as { data: FlightsFacts }).data;

describe("flight ui helpers", () => {
  it("formats durations", () => {
    expect(durationParts(185)).toEqual({ h: 3, m: "05" });
    expect(durationParts(60)).toEqual({ h: 1, m: "00" });
    expect(limitHours(210)).toBe(3.5);
    expect(limitHours(180)).toBe(3);
  });

  it("separates directions per pair", () => {
    const data = d(found);
    const pair = data.pairs[0];
    expect(legsOfPair(pair, data.legs, "out").every((l) => l.from === pair.from && l.to === pair.to)).toBe(true);
    expect(legsOfPair(pair, data.legs, "back").every((l) => l.from === pair.to)).toBe(true);
  });

  it("derives verified vs proxy vs not checked", () => {
    const f = d(found);
    expect(pairState(f.pairs[0], f.mode, f.legs)).toBe("found");
    const p = d(proxy);
    expect(pairState(p.pairs[0], p.mode, p.legs)).toBe("foundProxy");
    const m = d(mixed);
    expect(pairState(m.pairs[0], m.mode, m.legs)).toBe("foundProxy");
    expect(pairState(m.pairs[1], m.mode, m.legs)).toBe("notPublished");
    expect(pairState({ ...m.pairs[1], status: "not_checked" }, m.mode, m.legs)).toBe("notChecked");
    expect(pairState({ ...m.pairs[1], status: "none" }, m.mode, m.legs)).toBe("none");
  });

  it("filters too long legs", () => {
    expect(fittingLegs([{ tooLong: true as const }, {}])).toHaveLength(1);
  });

  it("counts adults for links", () => {
    const e = (count: number, age: ResolvedEntry["age"]): ResolvedEntry => ({ kind: "composition", count, isSelf: false, age });
    expect(adultsFromEntries(null)).toBe(1);
    expect(adultsFromEntries([e(2, { status: "known", age: 40, approximate: false }), e(1, { status: "known", age: 3, approximate: false }), e(1, { status: "unknown" })])).toBe(3);
    expect(adultsFromEntries([e(1, { status: "known", age: 5, approximate: false })])).toBe(1);
  });
});
