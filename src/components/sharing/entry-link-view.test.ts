import { describe, expect, it } from "vitest";
import type { StoredEntry, TravelGroup } from "@/lib/domain/group";
import { entryDeleteLocked, entryLinkView } from "./entry-link-view";

/** Example of docs/specs/group-sharing.md 1.5: A (owner, is_self), typed entry "B" that B claims, a free entry "Kim". */
const self = { id: "sa", kind: "member", isSelf: true, position: 0, traits: {} } as unknown as StoredEntry;
const entry = (id: string, extra: Partial<StoredEntry> = {}) =>
  ({ id, kind: "member", isSelf: false, name: id, position: 1, traits: {}, ...extra }) as unknown as StoredEntry;
const group = (access: TravelGroup["access"], myEntryId: string | null) => ({ access, myEntryId });

describe("entryLinkView: labels per viewer", () => {
  it("viewer A (owner): own entry 'You', linked entry '{name} check' with a remove button, free entry nothing", () => {
    const a = group("owner", "sa");
    expect(entryLinkView(a, { ...self, link: { kind: "me" } })).toEqual({ who: "you", mark: null, action: null });
    expect(entryLinkView(a, entry("B", { link: { kind: "person", name: "Ben" } }))).toEqual({
      who: "typed",
      mark: { kind: "person", name: "Ben" },
      action: "remove",
    });
    expect(entryLinkView(a, entry("B", { link: { kind: "account" } })).action).toBe("remove"); // no name known
    expect(entryLinkView(a, entry("Kim")).action).toBeNull(); // the owner never claims
  });

  it("viewer B (claimed 'B'): 'You' with 'That's not me', the owner's entry by name, no claim anywhere else", () => {
    const b = group("write", "B");
    expect(entryLinkView(b, entry("B", { link: { kind: "me" } }))).toEqual({ who: "you", mark: null, action: "unclaim" });
    expect(entryLinkView(b, self).who).toBe("groupOwner");
    expect(entryLinkView(b, self).action).toBeNull();
    expect(entryLinkView(b, entry("Kim")).action).toBeNull();
  });

  it("viewer C (no claim): typed name with 'Linked' on B's entry, 'That's me' on free entries only", () => {
    const c = group("read", null);
    expect(entryLinkView(c, entry("B", { link: { kind: "account" } }))).toEqual({ who: "typed", mark: { kind: "account" }, action: null });
    expect(entryLinkView(c, entry("Kim")).action).toBe("claim");
    expect(entryLinkView(c, self).action).toBeNull(); // is_self is never claimable
    expect(entryLinkView(c, { kind: "composition", id: "g", count: 2, position: 2, traits: {} } as unknown as StoredEntry).action).toBeNull();
  });

  it("never offers a claim to the owner or after a claim, and never uses the raw user id for display", () => {
    expect(entryLinkView(group("read", "B"), entry("Kim")).action).toBeNull();
    const withId = entry("B", { linkedUserId: "00000000-0000-4000-8000-000000000001", link: { kind: "account" } });
    expect(JSON.stringify(entryLinkView(group("read", null), withId))).not.toContain("0000");
  });
});

describe("entryDeleteLocked", () => {
  it("owner may delete anything; a write grantee not the is_self entry or an entry linked to someone else", () => {
    expect(entryDeleteLocked(group("owner", "sa"), { ...self, link: { kind: "me" } })).toBe(false);
    const b = group("write", "B");
    expect(entryDeleteLocked(b, self)).toBe(true);
    expect(entryDeleteLocked(b, entry("C", { link: { kind: "account" } }))).toBe(true);
    expect(entryDeleteLocked(b, entry("B", { link: { kind: "me" } }))).toBe(false);
    expect(entryDeleteLocked(b, entry("Kim"))).toBe(false);
  });
});
