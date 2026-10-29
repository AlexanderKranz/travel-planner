import { describe, expect, it } from "vitest";
import { GroupParse, TravelGroupInput } from "@/lib/domain";
import { draftToAgeSource, draftToCompositionInput, draftToInput, emptyDraft, hasTraitValue, parseToDrafts, tripEntryToDraft } from "./draft";

describe("draftToInput", () => {
  it("builds a composition with approximate age", () => {
    const d = {
      ...emptyDraft("composition"),
      count: "5",
      ageMode: "approx" as const,
      age: "45",
    };
    expect(draftToInput(d)).toMatchObject({
      kind: "composition",
      count: 5,
      age: { ageMode: "approx", age: 45 },
    });
  });

  it("drops age when a member has a birthdate", () => {
    const d = {
      ...emptyDraft("member"),
      name: "Mia",
      birthdate: "2020-05-01",
      ageMode: "exact" as const,
      age: "4",
    };
    const input = draftToInput(d);
    expect(input).toMatchObject({
      kind: "member",
      name: "Mia",
      birthdate: "2020-05-01",
    });
    expect(input.age).toBeUndefined();
  });

  it("self has no name, birthdate or age", () => {
    const d = {
      ...emptyDraft("member", true),
      name: "x",
      birthdate: "1980-01-01",
    };
    expect(draftToInput(d)).toMatchObject({
      isSelf: true,
      name: undefined,
      birthdate: undefined,
    });
  });

  it("marks a missing exact age as NaN so validation rejects it", () => {
    const d = { ...emptyDraft("composition"), ageMode: "exact" as const };
    expect(draftToAgeSource(d).age).toBeUndefined();
  });

  it("sends only traits selected for the group", () => {
    const d = {
      ...emptyDraft("member"),
      name: "Mia",
      diet: "vegan, nuts",
      golfHandicap: "18",
      needsNap: true,
    };
    expect(draftToInput(d).traits).toEqual({});
    expect(draftToInput(d, ["diet", "needsNap"]).traits).toEqual({
      diet: ["vegan", "nuts"],
      needsNap: true,
    });
  });

  it("detects trait values", () => {
    const d = { ...emptyDraft("member"), golfHandicap: "12" };
    expect(hasTraitValue(d, "golfHandicap")).toBe(true);
    expect(hasTraitValue(d, "diet")).toBe(false);
  });
});

describe("parseToDrafts (Adjust)", () => {
  const opts = (profileBirthdate: string | null) => ({ today: "2027-03-13", profileBirthdate, roleLabel: (r: string) => `role:${r}` });
  const parse = GroupParse.parse({
    v: 1,
    notes: [],
    travellers: [
      { count: 5, ageMode: "relativeToMe", ageOffset: 0, label: "Freunde", role: "adult" },
      { count: 1, ageMode: "relativeToMe", ageOffset: -5, label: "Ben" },
      { count: 2, ageMode: "exact", age: 7, role: "child" },
      { count: 1, role: "infant" },
    ],
  });

  it("keeps relative-to-me as relative; an offset becomes an approximate age when the profile age is known", () => {
    const d = parseToDrafts(parse, opts("1981-03-13"));
    expect(d.map((x) => [x.count, x.label, x.ageMode, x.age])).toEqual([
      ["5", "Freunde", "relativeToMe", ""],
      ["1", "Ben", "approx", "41"],
      ["2", "", "exact", "7"],
      ["1", "role:infant", "", ""],
    ]);
  });

  it("without a profile birthdate the offset is dropped (stays about my age)", () => {
    const d = parseToDrafts(parse, opts(null));
    expect(d[1].ageMode).toBe("relativeToMe");
    expect(d[1].age).toBe("");
  });

  it("the drafts build valid composition inputs", () => {
    for (const d of parseToDrafts(parse, opts("1981-03-13"))) {
      expect(draftToCompositionInput(d)).toMatchObject({ kind: "composition" });
    }
    expect(TravelGroupInput.safeParse({ name: "g", entries: parseToDrafts(parse, opts(null)).map((d) => draftToInput(d)) }).success).toBe(true);
  });
});

describe("tripEntryToDraft", () => {
  it("round-trips a stored one-off entry", () => {
    const d = tripEntryToDraft({ count: 2, label: "x", age: { ageMode: "approx", age: 40 }, ageAsOf: "2026-10-29" });
    expect(draftToCompositionInput(d)).toMatchObject({ count: 2, label: "x", age: { ageMode: "approx", age: 40 } });
    expect(d.ageAsOf).toBe("2026-10-29");
  });
});
