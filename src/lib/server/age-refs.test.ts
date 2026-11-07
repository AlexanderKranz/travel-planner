import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ groupOwner: vi.fn() }));
vi.mock("./owner-context", () => ({ loadGroupOwnerBirthdate: h.groupOwner }));

import { loadAgeRefs } from "./age-refs";

const T = "trip-owner";
const entries = [
  { id: "e-self", isSelf: true },
  { id: "e-me", linkedUserId: T },
  { id: "e-other" },
];

beforeEach(() => {
  h.groupOwner.mockReset().mockResolvedValue({ birthdate: "1960-01-01", displayName: "Gerda" });
});

// The plan pipeline and the trip page both call loadAgeRefs, so they cannot diverge; these are the values the pipeline
// test (plan-pipeline.test.ts, "group owner anchors") asserts on the pipeline side.
describe("loadAgeRefs (shared by the plan pipeline and the trip page)", () => {
  it("T = G or the one-off group: no secret-key read", async () => {
    expect(await loadAgeRefs({ tripOwnerId: T, tripOwnerBirthdate: "1980-05-06", group: { ownerId: T, entries } })).toEqual({
      self: "1980-05-06", me: { birthdate: "1980-05-06" }, meIs: "tripOwner", tripOwnerEntryId: "e-self",
    });
    expect(await loadAgeRefs({ tripOwnerId: T, tripOwnerBirthdate: "1980-05-06", group: null })).toMatchObject({ self: "1980-05-06" });
    expect(h.groupOwner).not.toHaveBeenCalled();
  });

  it("T != G with a link: is_self is the group owner's, 'about my age' the linked entry's", async () => {
    expect(await loadAgeRefs({ tripOwnerId: T, tripOwnerBirthdate: "1980-05-06", group: { ownerId: "g", entries } })).toEqual({
      self: "1960-01-01", me: { entryId: "e-me", fallback: "1980-05-06" }, meIs: "tripOwner", tripOwnerEntryId: "e-me",
    });
    expect(h.groupOwner).toHaveBeenCalledWith("g");
  });

  it("T != G without a link: both are the group owner's", async () => {
    const unlinked = entries.filter((e) => !e.linkedUserId);
    expect(await loadAgeRefs({ tripOwnerId: T, tripOwnerBirthdate: "1980-05-06", group: { ownerId: "g", entries: unlinked } })).toEqual({
      self: "1960-01-01", me: { birthdate: "1960-01-01" }, meIs: "groupOwner", tripOwnerEntryId: null,
    });
  });

  it("an unreadable group owner profile is null", async () => {
    h.groupOwner.mockResolvedValue(null);
    expect(await loadAgeRefs({ tripOwnerId: T, tripOwnerBirthdate: null, group: { ownerId: "g", entries } })).toBeNull();
  });
});
