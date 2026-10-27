import { describe, expect, it } from "vitest";
import { draftToAgeSource, draftToInput, emptyDraft, hasTraitValue } from "./draft";

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
