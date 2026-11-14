import { describe, expect, it } from "vitest";
import { ageOn } from "@/lib/age";
import { birthdateForAge, personLabel, shareErrorKey, sharedGroupOptions, sharedPurposeOptions } from "./helpers";

describe("personLabel", () => {
  it("prefers the name and falls back to the email", () => {
    expect(personLabel({ name: " Ben ", email: "b@x.test" })).toBe("Ben");
    expect(personLabel({ name: null, email: "b@x.test" })).toBe("b@x.test");
    expect(personLabel({ name: "  ", email: "b@x.test" })).toBe("b@x.test");
  });
});

describe("shareErrorKey", () => {
  it("keeps the sharing errors and maps the rest to failed", () => {
    expect(shareErrorKey("no_account")).toBe("no_account");
    expect(shareErrorKey("self_share")).toBe("self_share");
    expect(shareErrorKey("limit_reached")).toBe("limit_reached");
    expect(shareErrorKey("share_daily_limit")).toBe("share_daily_limit");
    expect(shareErrorKey("already_linked")).toBe("already_linked");
    expect(shareErrorKey("already_claimed")).toBe("already_claimed");
    expect(shareErrorKey("busy")).toBe("failed");
  });
});

describe("birthdateForAge", () => {
  it.each([
    [45, "2027-06-15"],
    [0, "2027-02-28"],
    [8, "2028-02-29"],
    [30, "2027-01-01"],
  ])("gives age %i on %s", (age, date) => {
    expect(ageOn(birthdateForAge(age, date), date)).toBe(age);
  });
});

describe("sharedPurposeOptions", () => {
  const owner = { id: "o", name: "Mia", email: "m@x.test" };
  const base = { id: "s", resourceId: "p", owner, access: "read" as const, createdAt: "", trip: null, group: null, tour: null };
  it("lists usable purpose shares only, labelled with the owner", () => {
    const purpose = (id: string, usable: boolean) => ({ id, name: `P${id}`, usable }) as never;
    const out = sharedPurposeOptions([
      { ...base, resource: "purpose", purpose: purpose("1", true) },
      { ...base, resource: "purpose", purpose: purpose("2", false) },
      { ...base, resource: "purpose", purpose: null },
      { ...base, resource: "trip", purpose: null },
    ]);
    expect(out).toEqual([{ id: "1", name: "P1", ownerName: "Mia" }]);
  });
});

describe("sharedGroupOptions", () => {
  const owner = { id: "o", name: "Mia", email: "m@x.test" };
  const base = { id: "s", resourceId: "g", owner, access: "write" as const, createdAt: "", trip: null, purpose: null, tour: null };
  it("lists group shares (either level) with the owner's name, nothing else", () => {
    const group = { id: "g1", name: "Friends" } as never;
    expect(
      sharedGroupOptions([
        { ...base, resource: "group", group },
        { ...base, resource: "group", group: null },
        { ...base, resource: "trip", group: null },
      ]),
    ).toEqual([{ id: "g1", name: "Friends", ownerName: "Mia" }]);
  });
});
