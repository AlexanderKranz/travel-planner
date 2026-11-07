import { describe, expect, it } from "vitest";
import { ageRefs, meAge, ownAgeRefs, resolveAge, resolveGroupAges, type AgeRefs, type AgeSource } from "./group";
import { resolveGroup, type GroupSource } from "./group-text";

// docs/specs/group-sharing.md 1.4 and 1.5: whose age is "self" and "about my age".

const TRAVEL = "2027-03-14";
const A = "user-a"; // group owner, is_self
const B = "user-b"; // recipient, linked to entry "B"
const A_BIRTH = "1960-05-01"; // 66 on TRAVEL
const B_BIRTH = "1990-05-01"; // 36 on TRAVEL

const entries: (AgeSource & { id: string; linkedUserId?: string })[] = [
  { id: "e-a", kind: "member", isSelf: true },
  { id: "e-b", kind: "member", name: "B", linkedUserId: B },
  { id: "e-kid", kind: "member", name: "Kid", age: { ageMode: "relativeToMe" } },
];

describe("ageRefs: the three cases of 1.4", () => {
  it("T = G (every existing trip, own group or the one-off group): one birthdate for self and 'about my age'", () => {
    const refs = ageRefs({ tripOwnerId: A, tripOwnerBirthdate: A_BIRTH, groupOwnerId: A, groupOwnerBirthdate: A_BIRTH, entries });
    expect(refs).toEqual({ self: A_BIRTH, me: { birthdate: A_BIRTH }, meIs: "tripOwner", tripOwnerEntryId: "e-a" });
    expect(ageRefs({ tripOwnerId: A, tripOwnerBirthdate: A_BIRTH, groupOwnerId: null, groupOwnerBirthdate: null, entries: [] })).toEqual({
      self: A_BIRTH,
      me: { birthdate: A_BIRTH },
      meIs: "tripOwner",
      tripOwnerEntryId: null,
    });
    // Today's string form gives the same result: no existing plan input changes.
    expect(resolveGroupAges(entries, TRAVEL, refs)).toEqual(resolveGroupAges(entries, TRAVEL, A_BIRTH));
    expect(resolveGroupAges(entries, TRAVEL, refs)).toEqual(resolveGroupAges(entries, TRAVEL, ownAgeRefs(A_BIRTH)));
  });

  it("T != G, T linked to entry X: self is G's, 'about my age' is X's, the label goes to X", () => {
    const refs = ageRefs({ tripOwnerId: B, tripOwnerBirthdate: B_BIRTH, groupOwnerId: A, groupOwnerBirthdate: A_BIRTH, entries });
    expect(refs).toEqual({ self: A_BIRTH, me: { entryId: "e-b", fallback: B_BIRTH }, meIs: "tripOwner", tripOwnerEntryId: "e-b" });
  });

  it("T != G, no link: both are G's, the label goes nowhere", () => {
    const refs = ageRefs({ tripOwnerId: "user-c", tripOwnerBirthdate: "2000-01-01", groupOwnerId: A, groupOwnerBirthdate: A_BIRTH, entries });
    expect(refs).toEqual({ self: A_BIRTH, me: { birthdate: A_BIRTH }, meIs: "groupOwner", tripOwnerEntryId: null });
    expect(resolveGroupAges(entries, TRAVEL, refs).some((r) => r.isTripOwner)).toBe(false);
  });
});

describe("the linked entry's age (1.4)", () => {
  const refs = (fallback: string | null = B_BIRTH): AgeRefs => ({
    self: A_BIRTH,
    me: { entryId: "x", fallback },
    meIs: "tripOwner",
    tripOwnerEntryId: "x",
  });
  const x = (over: Partial<AgeSource>): AgeSource => ({ id: "x", kind: "member", name: "X", ...over });

  it("a typed birthdate wins over the profile", () => {
    expect(meAge(refs(), TRAVEL, [x({ birthdate: "1985-03-14" })])).toBe(42);
  });
  it("a stated age is advanced by the years since it was stated", () => {
    expect(meAge(refs(), TRAVEL, [x({ age: { ageMode: "exact", age: 40 }, ageAsOf: "2025-03-14" })])).toBe(42);
    expect(meAge(refs(), TRAVEL, [x({ age: { ageMode: "approx", age: 40 } })])).toBe(40);
  });
  it("relativeToMe on the linked entry itself, or no data: the trip owner's profile birthdate", () => {
    expect(meAge(refs(), TRAVEL, [x({ age: { ageMode: "relativeToMe" } })])).toBe(36);
    expect(meAge(refs(), TRAVEL, [x({})])).toBe(36);
  });
  it("no data and no fallback: unknown, so 'about my age' stays a statement without a number", () => {
    expect(meAge(refs(null), TRAVEL, [x({})])).toBeNull();
    const kid: AgeSource = { kind: "member", name: "Kid", age: { ageMode: "relativeToMe" } };
    expect(resolveAge(kid, TRAVEL, refs(null), [x({})])).toEqual({ status: "aboutMyAge" });
  });
  it("relativeToMe of another entry uses the linked entry's age", () => {
    const rows = resolveGroupAges(
      [
        { id: "x", kind: "member", name: "X", birthdate: "1985-03-14" },
        { id: "k", kind: "member", name: "K", age: { ageMode: "relativeToMe" } },
      ],
      TRAVEL,
      refs(),
    );
    expect(rows[1].age).toEqual({ status: "known", age: 42, approximate: true });
  });
});

describe("isTripOwner and the display birthdate", () => {
  it("T = G: the is_self row; T != G linked: the linked entry only; the is_self row shows G's birthdate", () => {
    const own = resolveGroupAges(entries, TRAVEL, ownAgeRefs(A_BIRTH));
    expect(own.map((r) => r.isTripOwner)).toEqual([true, false, false]);
    const refs = ageRefs({ tripOwnerId: B, tripOwnerBirthdate: B_BIRTH, groupOwnerId: A, groupOwnerBirthdate: A_BIRTH, entries });
    const rows = resolveGroupAges(entries, TRAVEL, refs);
    expect(rows.map((r) => r.isTripOwner)).toEqual([false, true, false]);
    expect(rows[0]).toMatchObject({ isSelf: true, birthdate: A_BIRTH, age: { status: "known", age: 66 } });
  });
});

describe("example 1.5: A's group with A (is_self) and 'B'; B linked", () => {
  const source: GroupSource = {
    entries: [
      { id: "e-a", kind: "member", isSelf: true },
      { id: "e-b", kind: "member", name: "B", birthdate: "1990-05-01" },
      { id: "e-rel", kind: "member", name: "Rel", age: { ageMode: "relativeToMe" } },
    ],
    traitKeys: [],
  };
  const rows = [{ id: "e-a", isSelf: true }, { id: "e-b", linkedUserId: B }, { id: "e-rel" }];
  const refsFor = (tripOwnerId: string, tripOwnerBirthdate: string) =>
    ageRefs({ tripOwnerId, tripOwnerBirthdate, groupOwnerId: A, groupOwnerBirthdate: A_BIRTH, entries: rows });

  it("T = A: 'self' on A's entry, 'about my age' = A", () => {
    const r = resolveGroup(source, TRAVEL, refsFor(A, A_BIRTH)).rows;
    expect(r.map((x) => x.isTripOwner)).toEqual([true, false, false]);
    expect(r[2].age).toEqual({ status: "known", age: 66, approximate: true });
  });
  it("T = B: 'self' on entry B (A's entry is a plain traveller), 'about my age' = entry B's own age", () => {
    const r = resolveGroup(source, TRAVEL, refsFor(B, "1991-01-01")).rows;
    expect(r.map((x) => x.isTripOwner)).toEqual([false, true, false]);
    expect(r[2].age).toEqual({ status: "known", age: 36, approximate: true }); // the typed birthdate, not B's profile
  });
  it("B before claiming: 'about my age' refers to the group owner", () => {
    const unlinked = ageRefs({
      tripOwnerId: B,
      tripOwnerBirthdate: B_BIRTH,
      groupOwnerId: A,
      groupOwnerBirthdate: A_BIRTH,
      entries: [rows[0], { id: "e-b" }, rows[2]],
    });
    expect(unlinked.meIs).toBe("groupOwner");
    expect(resolveGroup(source, TRAVEL, unlinked).rows[2].age).toEqual({ status: "known", age: 66, approximate: true });
  });
  it("ages and labels are a function of the trip owner, never of the viewer or the actor", () => {
    // Nothing about a viewer goes into the refs: viewing A's trip as A, B or C gives the same refs and the same rows.
    const viewed = [A, B, "user-c"].map(() => resolveGroup(source, TRAVEL, refsFor(A, A_BIRTH)));
    expect(viewed[1]).toEqual(viewed[0]);
    expect(viewed[2]).toEqual(viewed[0]);
  });
});
