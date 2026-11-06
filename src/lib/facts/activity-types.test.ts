import { describe, expect, it } from "vitest";
import {
  ACTIVITY_SOURCES,
  ACTIVITY_TYPES,
  MAX_ACTIVITY_GROUPS,
  expandWish,
  groupHasGeoapify,
  groupsForWishes,
  placeGroup,
  radiusForGroup,
  typesInGroup,
} from "./activity-types";
import { MAX_RADIUS_KM } from "./interest-sources";

describe("activity catalogue", () => {
  it("every type has a group, at least one filter and a sane radius", () => {
    for (const t of ACTIVITY_TYPES) {
      const s = ACTIVITY_SOURCES[t];
      expect(s.group, t).toBeTruthy();
      expect(s.filters.length, t).toBeGreaterThan(0);
      expect(s.defaultRadiusKm, t).toBeGreaterThan(0);
      expect(s.defaultRadiusKm, t).toBeLessThanOrEqual(MAX_RADIUS_KM);
    }
  });
  it("footgolf is kept on purpose; other rare types are dropped", () => {
    expect(ACTIVITY_TYPES as readonly string[]).toContain("footgolf");
    for (const t of ["high_ropes", "laser_tag"]) expect(ACTIVITY_TYPES as readonly string[]).not.toContain(t);
  });
  it("every type is in exactly one group", () => {
    expect(typesInGroup("indoor")).toContain("climbing_hall");
    expect(typesInGroup("outdoor")).toContain("minigolf");
    expect(typesInGroup("going_out")).toEqual(["bar"]);
    expect(typesInGroup("indoor").length + typesInGroup("outdoor").length + 1).toBe(ACTIVITY_TYPES.length);
  });
  it("indoor=yes makes an outdoor type indoor", () => {
    expect(placeGroup("minigolf", { indoor: "yes" })).toBe("indoor");
    expect(placeGroup("minigolf", {})).toBe("outdoor");
    expect(placeGroup("cinema", { indoor: "no" })).toBe("indoor");
    expect(placeGroup("bar", { indoor: "yes" })).toBe("going_out");
  });
  it("group radius is the largest type radius; Geoapify only where every type is mapped", () => {
    expect(radiusForGroup("outdoor")).toBe(25);
    expect(radiusForGroup("going_out")).toBe(3);
    expect(groupHasGeoapify("going_out")).toBe(true);
    expect(groupHasGeoapify("indoor")).toBe(false); // karaoke has no category
  });
});

describe("expandWish", () => {
  it("a closed wish keeps exactly its types", () => {
    expect(expandWish({ types: ["escape_game"], open: false })).toEqual(["escape_game"]);
  });
  it("an open wish expands to the whole group (catalogue order)", () => {
    const t = expandWish({ types: ["escape_game"], open: true });
    expect(t).toEqual(typesInGroup("indoor"));
    expect(t).toContain("bowling");
    expect(t).not.toContain("minigolf");
  });
  it("an open wish without types uses its group; without either it is empty", () => {
    expect(expandWish({ types: [], open: true, group: "outdoor" })).toEqual(typesInGroup("outdoor"));
    expect(expandWish({ types: [], open: true })).toEqual([]);
    expect(expandWish({ types: [], open: false, group: "outdoor" })).toEqual([]);
  });
});

describe("groupsForWishes", () => {
  it("an indoor wish + an outdoor wish = two groups", () => {
    expect(
      groupsForWishes([
        { types: ["escape_game"], open: true },
        { types: ["rowing"], open: true },
      ]),
    ).toEqual(["indoor", "outdoor"]);
  });
  it("does not add a second group for a type already covered", () => {
    expect(groupsForWishes([{ types: ["bowling"], open: false }, { types: ["cinema"], open: false }])).toEqual(["indoor"]);
  });
  it("is capped", () => {
    const g = groupsForWishes([
      { types: ["escape_game"], open: false },
      { types: ["canoe"], open: false },
      { types: ["bar"], open: false },
    ]);
    expect(g).toHaveLength(MAX_ACTIVITY_GROUPS);
  });
});
