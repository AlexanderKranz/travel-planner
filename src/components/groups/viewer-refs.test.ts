import { describe, expect, it } from "vitest";
import type { StoredEntry, TravelGroup } from "@/lib/domain/group";
import { resolveGroupAges, type AgeSource } from "@/lib/group";
import { viewerAgeRefs } from "./viewer-refs";

const member = (id: string, extra: Partial<StoredEntry> = {}) =>
  ({ id, position: 0, kind: "member", isSelf: false, traits: {}, name: id, ...extra }) as unknown as StoredEntry;

const owned = (entries: StoredEntry[]) => ({ ownerId: "A", access: "owner", owner: null, entries }) as Pick<TravelGroup, "ownerId" | "access" | "owner" | "entries">;
const shared = (entries: StoredEntry[], birthdate: string | null, ageToday = 40) =>
  ({
    ownerId: "A",
    access: "read",
    owner: { id: "A", name: "Mia", birthdate, ageToday },
    entries,
  }) as Pick<TravelGroup, "ownerId" | "access" | "owner" | "entries">;

const src = (e: StoredEntry): AgeSource => ({ id: e.id, kind: "member", isSelf: e.kind === "member" && e.isSelf, name: e.id, age: { ageMode: "relativeToMe" } });
const TODAY = "2026-11-07";

describe("viewerAgeRefs", () => {
  it("owner: one birthdate for both anchors", () => {
    const r = viewerAgeRefs(owned([]), { id: "A", birthdate: "1980-01-01" }, TODAY);
    expect(r).toMatchObject({ self: "1980-01-01", meIs: "tripOwner" });
  });

  it("recipient without a claim: self and 'about my age' are the group owner's, wording says so", () => {
    const entries = [member("self", { isSelf: true } as Partial<StoredEntry>), member("kid")];
    const r = viewerAgeRefs(shared(entries, "1980-05-05"), { id: "B", birthdate: "1990-01-01" }, TODAY);
    expect(r).toMatchObject({ self: "1980-05-05", meIs: "groupOwner", tripOwnerEntryId: null });
    const rows = resolveGroupAges([{ ...src(entries[1]) }], TODAY, r);
    expect(rows[0].age).toEqual({ status: "known", age: 46, approximate: true });
  });

  it("recipient who claimed an entry: 'about my age' follows that entry, fallback the own profile", () => {
    const entries = [member("self", { isSelf: true } as Partial<StoredEntry>), member("me", { linkedUserId: "B", link: { kind: "me" } }), member("kid")];
    const r = viewerAgeRefs(shared(entries, "1980-05-05"), { id: "B", birthdate: "1990-01-01" }, TODAY);
    expect(r.meIs).toBe("tripOwner");
    const rows = resolveGroupAges(entries.map(src), TODAY, r);
    const kid = rows.find((x) => x.id === "kid");
    expect(kid?.age).toEqual({ status: "known", age: 36, approximate: true }); // the claimed entry has no data: B's profile
  });

  it("no birthdate sent (no is_self entry): the age stands in so 'about my age' still works", () => {
    const r = viewerAgeRefs(shared([member("kid")], null, 50), { id: "B", birthdate: null }, TODAY);
    const rows = resolveGroupAges([src(member("kid"))], TODAY, r);
    expect(rows[0].age).toEqual({ status: "known", age: 50, approximate: true });
  });
});
