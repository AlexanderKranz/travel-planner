import { describe, expect, it } from "vitest";
import { canClaim, EntryLinkInput, type StoredEntry } from "./group";

const free: StoredEntry = { id: "e1", position: 0, kind: "member", isSelf: false, name: "Bea", traits: {} };
const recipient = { access: "read" as const, myEntryId: null };

describe("canClaim ('That's me', group-sharing spec 1.3, 4.2)", () => {
  it("is offered to a read or write recipient on a free named member", () => {
    expect(canClaim(recipient, free)).toBe(true);
    expect(canClaim({ access: "write", myEntryId: null }, free)).toBe(true);
  });
  it("never for the owner", () => {
    expect(canClaim({ access: "owner", myEntryId: null }, free)).toBe(false);
  });
  it("not once the viewer has claimed an entry in this group", () => {
    expect(canClaim({ access: "read", myEntryId: "e9" }, free)).toBe(false);
  });
  it("not on the owner's is_self entry, a composition, or an entry that is already linked", () => {
    expect(canClaim(recipient, { ...free, isSelf: true })).toBe(false);
    expect(canClaim(recipient, { id: "c1", position: 1, kind: "composition", count: 3, traits: {} })).toBe(false);
    expect(canClaim(recipient, { ...free, linkedUserId: "u2" })).toBe(false);
    expect(canClaim(recipient, { ...free, link: { kind: "account" } })).toBe(false);
    expect(canClaim(recipient, { ...free, link: { kind: "me" } })).toBe(false);
  });
});

describe("EntryLinkInput", () => {
  it("needs a uuid", () => {
    expect(EntryLinkInput.safeParse({ entryId: "11111111-1111-4111-8111-111111111111" }).success).toBe(true);
    expect(EntryLinkInput.safeParse({ entryId: "x" }).success).toBe(false);
    expect(EntryLinkInput.safeParse({}).success).toBe(false);
  });
});
