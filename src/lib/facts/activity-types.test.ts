import { describe, expect, it } from "vitest";
import {
  ACTIVITY_SOURCES,
  ACTIVITY_TYPES,
  expandWish,
  groupHasGeoapify,
  groupsForWishes,
  placeGroup,
  radiusForGroup,
  typesInGroup,
  isOpenAirBath,
} from "./activity-types";
import { MAX_RADIUS_KM } from "./interest-sources";
import { matchesFilter } from "./places";

/** Types an adult open wish expands to: the group without family types. */
const adult = (g: "indoor" | "outdoor") => typesInGroup(g).filter((t) => !ACTIVITY_SOURCES[t].family);

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
  it("family types (addendum A1): groups, filters and Geoapify", () => {
    expect(ACTIVITY_SOURCES.indoor_play).toMatchObject({ group: "indoor", filters: [`["leisure"="indoor_play"]`] });
    expect(ACTIVITY_SOURCES.indoor_play.geoapify).toBeUndefined();
    expect(ACTIVITY_SOURCES.swimming.group).toBe("indoor");
    expect(ACTIVITY_SOURCES.swimming.filters).toContain(`["amenity"="public_bath"]`);
    expect(ACTIVITY_SOURCES.swimming.geoapify).toContain("sport.swimming_pool");
    expect(ACTIVITY_SOURCES.playground).toMatchObject({ group: "outdoor", filters: [`["leisure"="playground"]`], geoapify: ["leisure.playground"], defaultRadiusKm: 3 });
    expect(typesInGroup("indoor")).toEqual(expect.arrayContaining(["indoor_play", "swimming"]));
    expect(typesInGroup("outdoor")).toContain("playground");
    expect(placeGroup("playground", {})).toBe("outdoor");
  });
  it("open-air words: German compounds match, short words need word boundaries", () => {
    expect(isOpenAirBath({ name: "Waldfreibad Nord" })).toBe(true);
    expect(isOpenAirBath({ name: "Lido di Venezia" })).toBe(true);
    expect(isOpenAirBath({ name: "Seebad Heringsdorf" })).toBe(true);
    expect(isOpenAirBath({ name: "Lidobar Bad" })).toBe(false);
    expect(isOpenAirBath({ name: "Ostseebadhalle" })).toBe(false);
  });
  it("combined facilities and indoor names count as indoor unless indoor=no", () => {
    for (const name of ["Hallen- und Freibad Mitte", "Hallenbad & Freibad Süd", "Indoor & Outdoor Pool", "Therme am Freibad", "Sauna- und Freibad", "Erlebnisbad Strandbad"]) {
      expect(isOpenAirBath({ name }), name).toBe(false);
    }
    expect(isOpenAirBath({ name: "Hallen- und Freibad Mitte", indoor: "no" })).toBe(true);
    expect(isOpenAirBath({ name: "Freibad", covered: "yes" })).toBe(false);
    // Only the mapper's note says Freibad for an ambiguous name: open-air (recorded Passau PEB).
    expect(isOpenAirBath({ name: "Passauer Erlebnisbad (PEB)", note: "Freibad" })).toBe(true);
    expect(isOpenAirBath({ name: "Erlebnisbad" })).toBe(false);
  });
  it("open-air pools and bathing lakes count as outdoor swimming", () => {
    expect(placeGroup("swimming", { leisure: "water_park", name: "Freibad Haselbach" })).toBe("outdoor");
    expect(placeGroup("swimming", { amenity: "public_bath", name: "Raßbacher Naturbadeweiher" })).toBe("outdoor");
    expect(placeGroup("swimming", { leisure: "water_park", name: "Passauer Erlebnisbad (PEB)", note: "Freibad" })).toBe("outdoor");
    expect(placeGroup("swimming", { leisure: "water_park", name: "Aquapark", covered: "no" })).toBe("outdoor");
    expect(placeGroup("swimming", { leisure: "sports_centre", sport: "swimming", name: "Hallenbad Mitte" })).toBe("indoor");
    expect(placeGroup("swimming", { leisure: "water_park", name: "Freibad und Hallenbad", indoor: "yes" })).toBe("indoor");
    expect(placeGroup("swimming", { amenity: "public_bath", name: "Therme" })).toBe("indoor");
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
  it("an open wish expands to the whole group without family types (catalogue order)", () => {
    const t = expandWish({ types: ["escape_game"], open: true });
    expect(t).toEqual(adult("indoor"));
    expect(t).toContain("bowling");
    expect(t).not.toContain("minigolf");
  });
  it("an open wish without types uses its group; without either it is empty", () => {
    expect(expandWish({ types: [], open: true, group: "outdoor" })).toEqual(adult("outdoor"));
    expect(expandWish({ types: [], open: true })).toEqual([]);
    expect(expandWish({ types: [], open: false, group: "outdoor" })).toEqual([]);
  });
  it("family types (QA #137): never added to adult open wishes, kept for named ones and family open wishes", () => {
    expect(ACTIVITY_TYPES.filter((t) => ACTIVITY_SOURCES[t].family)).toEqual(["indoor_play", "swimming", "playground"]);
    const indoor = expandWish({ types: ["escape_game"], open: true });
    expect(indoor).not.toContain("indoor_play");
    expect(indoor).not.toContain("swimming");
    expect(expandWish({ types: ["rowing"], open: true })).not.toContain("playground");
    expect(expandWish({ types: [], open: true, group: "indoor" })).not.toContain("indoor_play");
    expect(expandWish({ types: ["indoor_play"], open: false })).toEqual(["indoor_play"]);
    expect(expandWish({ types: ["indoor_play"], open: true })).toEqual(typesInGroup("indoor"));
    expect(expandWish({ types: ["playground"], open: true })).toContain("minigolf");
    // The lookup union still has them, so a named wish is served by the same group query.
    expect(groupsForWishes([{ types: ["swimming"], open: false }])).toEqual(["indoor"]);
    expect(typesInGroup("indoor")).toContain("indoor_play");
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
  it("returns every needed group, up to all three", () => {
    expect(
      groupsForWishes([
        { types: ["escape_game"], open: false },
        { types: ["canoe"], open: false },
        { types: ["bar"], open: false },
      ]),
    ).toEqual(["indoor", "outdoor", "going_out"]);
  });
  it("an entry without types uses its valid group, otherwise it is dropped", () => {
    expect(groupsForWishes([{ types: [], open: true, group: "going_out" }])).toEqual(["going_out"]);
    expect(groupsForWishes([{ types: [], open: true }])).toEqual([]);
    expect(groupsForWishes([{ types: [], open: true, group: "day_event" as never }])).toEqual([]);
    expect(expandWish({ types: [], open: true, group: "day_event" as never })).toEqual([]);
  });
  it("with types, each type's own group is used and the entry's group is ignored", () => {
    expect(groupsForWishes([{ types: ["cinema"], open: false, group: "outdoor" }])).toEqual(["indoor"]);
    expect(expandWish({ types: ["cinema"], open: true, group: "outdoor" })).toEqual(adult("indoor"));
  });
});

describe("swimming filter (token-aware sport)", () => {
  const hits = (tags: Record<string, string>) => ACTIVITY_SOURCES.swimming.filters.some((f) => matchesFilter({ name: "X", ...tags }, f));
  it("matches a sports centre with swimming as one token of the list", () => {
    expect(hits({ leisure: "sports_centre", sport: "swimming" })).toBe(true);
    expect(hits({ leisure: "sports_centre", sport: "fitness;swimming" })).toBe(true);
    expect(hits({ leisure: "sports_centre", sport: "swimming; sauna" })).toBe(true);
  });
  it("does not match other sports, look-alikes, or a plain sports centre", () => {
    expect(hits({ leisure: "sports_centre", sport: "swimming_lessons" })).toBe(false);
    expect(hits({ leisure: "sports_centre", sport: "nonswimming" })).toBe(false);
    expect(hits({ leisure: "sports_centre", sport: "soccer" })).toBe(false);
    expect(hits({ leisure: "sports_centre" })).toBe(false);
    expect(hits({ leisure: "pitch", sport: "swimming" })).toBe(false);
  });
  it("water parks and public baths match without a sport tag; unnamed places never", () => {
    expect(hits({ leisure: "water_park" })).toBe(true);
    expect(hits({ amenity: "public_bath" })).toBe(true);
    expect(ACTIVITY_SOURCES.swimming.filters.some((f) => matchesFilter({ leisure: "water_park" }, f))).toBe(false);
  });
  it("playground and indoor_play need a name", () => {
    expect(matchesFilter({ leisure: "playground" }, ACTIVITY_SOURCES.playground.filters[0])).toBe(false);
    expect(matchesFilter({ leisure: "playground", name: "Spielplatz Am Dom" }, ACTIVITY_SOURCES.playground.filters[0])).toBe(true);
    expect(matchesFilter({ leisure: "indoor_play", name: "Kinderland" }, ACTIVITY_SOURCES.indoor_play.filters[0])).toBe(true);
  });
});
