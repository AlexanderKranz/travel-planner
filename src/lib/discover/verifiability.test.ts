import { describe, expect, it } from "vitest";
import { INTEREST_KEYS } from "@/lib/domain/interests";
import { INTEREST_SOURCES } from "@/lib/facts/interest-sources";
import { interestKeysOf, MAX_SEARCH_INTERESTS, selectSearchInterests, VERIFIABILITY } from "./verifiability";

describe("VERIFIABILITY", () => {
  it("has a row for every interest key (and no other)", () => {
    expect(Object.keys(VERIFIABILITY).sort()).toEqual([...INTEREST_KEYS].sort());
  });
  it("classes follow the spec table", () => {
    expect(VERIFIABILITY.golf).toEqual({ class: "place", min: 2 });
    expect(VERIFIABILITY.food_wine).toEqual({ class: "place", min: 1 });
    for (const k of ["beach", "hiking", "wellness", "family_activities", "nature_wildlife", "cycling"] as const) {
      expect(VERIFIABILITY[k].class, k).toBe("place");
    }
    for (const k of ["city_sightseeing", "museums", "history", "shopping", "photography"] as const) {
      expect(VERIFIABILITY[k].class, k).toBe("common");
    }
    for (const k of ["skiing", "architecture", "water_sports"] as const) expect(VERIFIABILITY[k].class, k).toBe("cache");
    for (const k of ["christmas_markets", "nightlife", "cruise", "festivals_events"] as const) expect(VERIFIABILITY[k].class, k).toBe("none");
  });
  it("only classes with a drop rule have a minimum", () => {
    for (const v of Object.values(VERIFIABILITY)) expect(v.class === "place" ? v.min >= 1 : v.min === 0).toBe(true);
  });
  it("stays consistent with the interest sources: no source means class none, an OSM source never none", () => {
    for (const k of INTEREST_KEYS) {
      const none = INTEREST_SOURCES[k].source === "none";
      expect(VERIFIABILITY[k].class === "none", k).toBe(none);
    }
  });
  it("classes 'cache' are exactly the OSM interests without a Geoapify mapping that the search skips", () => {
    for (const k of INTEREST_KEYS) {
      if (VERIFIABILITY[k].class !== "cache") continue;
      const s = INTEREST_SOURCES[k];
      expect(s.source === "osm" && !s.geoapify, k).toBe(true);
    }
  });
});

describe("selectSearchInterests", () => {
  it("at most 2", () => {
    expect(selectSearchInterests(["golf", "beach", "hiking"])).toHaveLength(MAX_SEARCH_INTERESTS);
  });
  it("those with a POI check first, then in purpose order", () => {
    expect(selectSearchInterests(["christmas_markets", "city_sightseeing", "golf"])).toEqual(["golf", "city_sightseeing"]);
    expect(selectSearchInterests(["skiing", "museums", "cruise"])).toEqual(["museums", "skiing"]);
  });
  it("E3: cruise and christmas markets are kept (as not checked) when nothing better exists", () => {
    expect(selectSearchInterests(["cruise", "christmas_markets"])).toEqual(["cruise", "christmas_markets"]);
  });
  it("E4: no interest key -> nothing is checked", () => {
    expect(selectSearchInterests([])).toEqual([]);
  });
});

describe("interestKeysOf", () => {
  it("keeps keys in order, drops custom text and the pseudo interest general", () => {
    expect(interestKeysOf(["golf", "flat courses", "general", "golf", "beach"])).toEqual(["golf", "beach"]);
  });
});
