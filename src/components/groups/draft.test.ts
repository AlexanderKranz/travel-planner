import { describe, expect, it } from "vitest";
import { draftToAgeSource, draftToInput, emptyDraft } from "./draft";

describe("draftToInput", () => {
  it("builds a composition with approximate age", () => {
    const d = { ...emptyDraft("composition"), count: "5", ageMode: "approx" as const, age: "45" };
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
    expect(input).toMatchObject({ kind: "member", name: "Mia", birthdate: "2020-05-01" });
    expect(input.age).toBeUndefined();
  });

  it("self has no name, birthdate or age", () => {
    const d = { ...emptyDraft("member", true), name: "x", birthdate: "1980-01-01" };
    expect(draftToInput(d)).toMatchObject({ isSelf: true, name: undefined, birthdate: undefined });
  });

  it("marks a missing exact age as NaN so validation rejects it", () => {
    const d = { ...emptyDraft("composition"), ageMode: "exact" as const };
    expect(draftToAgeSource(d).age).toBeUndefined();
  });
});
