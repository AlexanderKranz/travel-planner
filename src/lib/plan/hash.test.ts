import { describe, expect, it } from "vitest";
import { canonicalJson, planInputHash, purposeTagsHash } from "./hash";
import type { PlanInput } from "./input";

const input: PlanInput = {
  v: 1,
  lang: "de",
  trip: { dest: "Passau", kind: "city", days: 2, flights: false, notes: "Hafen ab 16:00" },
  dayList: [{ n: 1 }, { n: 2 }],
  places: [{ id: "p1", name: "Dom", cat: "tourism=attraction", km: 0.4, i: "general" }],
  noSource: [],
};

describe("canonicalJson", () => {
  it("sorts keys, drops undefined, keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [3, 1] } })).toBe('{"a":{"c":[3,1]},"b":1}');
    expect(canonicalJson([undefined, 1])).toBe("[null,1]");
  });

  it("is invariant to key order and a jsonb-like round trip", () => {
    const shuffled = JSON.parse(JSON.stringify({ noSource: [], places: input.places, dayList: input.dayList, trip: input.trip, lang: "de", v: 1 }));
    expect(canonicalJson(shuffled)).toBe(canonicalJson(input));
    expect(planInputHash(shuffled)).toBe(planInputHash(input));
  });
});

describe("planInputHash", () => {
  it("is 64 hex chars and changes with the notes", () => {
    const h = planInputHash(input);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(planInputHash({ ...input, trip: { ...input.trip, notes: "Hafen ab 17:00" } })).not.toBe(h);
  });
});

describe("purposeTagsHash", () => {
  const p = { text: "Golf", constraints: ["flat"], guided: { interests: ["golf", "Pilze"] } };
  it("depends on text, constraints and custom interests only", () => {
    const h = purposeTagsHash(p);
    expect(purposeTagsHash({ ...p, guided: { interests: ["Pilze", "beach"], pace: "relaxed" } })).toBe(h);
    expect(purposeTagsHash({ ...p, text: "Golf!" })).not.toBe(h);
    expect(purposeTagsHash({ ...p, constraints: [] })).not.toBe(h);
    expect(purposeTagsHash({ ...p, guided: { interests: ["Pilze", "Wein"] } })).not.toBe(h);
  });
});
