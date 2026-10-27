import { describe, expect, it } from "vitest";
import { resolveAge, resolveGroupAges, stripTraits } from "./group";

const TRAVEL = "2027-03-14";

describe("resolveAge", () => {
  it("uses the entry birthdate", () => {
    expect(resolveAge({ kind: "member", name: "Ben", birthdate: "2015-03-15" }, TRAVEL)).toEqual({
      status: "known",
      age: 11,
      approximate: false,
    });
  });

  it("returns unknown when born after the travel date", () => {
    expect(resolveAge({ kind: "member", name: "Baby", birthdate: "2028-01-01" }, TRAVEL)).toEqual({
      status: "unknown",
    });
  });

  it("uses the profile birthdate for isSelf", () => {
    const self = { kind: "member", isSelf: true } as const;
    expect(resolveAge(self, TRAVEL, "1980-03-14")).toEqual({ status: "known", age: 47, approximate: false });
    expect(resolveAge(self, TRAVEL, null)).toEqual({ status: "unknown" });
  });

  it("advances a stated age by the full years since it was stated", () => {
    const entry = {
      kind: "composition",
      count: 5,
      age: { ageMode: "approx", age: 45 },
      ageAsOf: "2025-03-15",
    } as const;
    // 2025-03-15 -> 2027-03-14 is one full year
    expect(resolveAge(entry, TRAVEL)).toEqual({ status: "known", age: 46, approximate: true });
    expect(resolveAge({ ...entry, ageAsOf: "2025-03-14" }, TRAVEL)).toEqual({
      status: "known",
      age: 47,
      approximate: true,
    });
  });

  it("keeps exact stated ages exact and does not go back in time", () => {
    const entry = { kind: "composition", count: 1, age: { ageMode: "exact", age: 3 }, ageAsOf: "2030-01-01" } as const;
    expect(resolveAge(entry, TRAVEL)).toEqual({ status: "known", age: 3, approximate: false });
  });

  it("treats relativeToMe as approximate, or 'about my age' without a profile birthdate", () => {
    const entry = { kind: "composition", count: 2, age: { ageMode: "relativeToMe" } } as const;
    expect(resolveAge(entry, TRAVEL, "1980-01-01")).toEqual({ status: "known", age: 47, approximate: true });
    expect(resolveAge(entry, TRAVEL)).toEqual({ status: "aboutMyAge" });
  });

  it("returns unknown when no age is given", () => {
    expect(resolveAge({ kind: "composition", count: 2, label: "Eltern" }, TRAVEL)).toEqual({ status: "unknown" });
  });
});

describe("resolveGroupAges", () => {
  it("resolves a mixed group and passes labels through", () => {
    const result = resolveGroupAges(
      [
        { id: "a", kind: "member", isSelf: true },
        { id: "b", kind: "member", name: "Ben", birthdate: "2015-01-01" },
        { id: "c", kind: "composition", count: 3, label: "Freunde", age: { ageMode: "approx", age: 45 }, ageAsOf: "2027-01-01" },
      ],
      TRAVEL,
      "1980-03-14",
    );
    expect(result.map((r) => [r.id, r.count, r.age])).toEqual([
      ["a", 1, { status: "known", age: 47, approximate: false }],
      ["b", 1, { status: "known", age: 12, approximate: false }],
      ["c", 3, { status: "known", age: 45, approximate: true }],
    ]);
    expect(result[2].label).toBe("Freunde");
  });
});

describe("stripTraits", () => {
  it("keeps only enabled keys", () => {
    expect(stripTraits({ mobility: "limited", needsNap: true, diet: ["vegan"] }, ["needsNap", "diet"])).toEqual({
      needsNap: true,
      diet: ["vegan"],
    });
  });
  it("returns an empty object when no key is enabled or traits are missing", () => {
    expect(stripTraits({ golfHandicap: 12 }, [])).toEqual({});
    expect(stripTraits(undefined, ["diet"])).toEqual({});
  });
});
