import { describe, expect, it } from "vitest";
import type { PlanActivity, PlanPlace } from "@/lib/domain/plan";
import type { PlanInputStored } from "./input";
import { guardOpenAir, isOpenAirPlace, outOfSeason, placeClasses, winterAt } from "./open-air";

const place = (name: string, category: string, lat = 48.57): PlanPlace => ({
  name, category, lat, lon: 13.43, distanceKm: 1, osmUrl: "https://www.openstreetmap.org/way/1", source: "osm", fetchedAt: "f",
});
const stored = {
  llm: { activities: { places: [{ id: "a1", g: "indoor" }, { id: "a2", g: "outdoor" }] } },
  index: {
    p3: { key: "way/3", place: place("Passauer Erlebnisbad (PEB)", "leisure=water_park"), g: "outdoor" }, // OSM note "Freibad"
    p4: { key: "way/4", place: place("Babalu Funpark", "tourism=theme_park") },
    p5: { key: "way/5", place: place("Freibad Haselbach", "leisure=water_park") }, // older stored input: no g
    p6: { key: "way/6", place: place("Therme", "leisure=water_park"), g: "indoor" },
    a1: { key: "node/7", place: place("Indoor Inhalatorium", "leisure=indoor_play") },
    a2: { key: "way/8", place: place("Waldfreibad", "leisure=water_park") },
  },
} as unknown as PlanInputStored;
const c = placeClasses(stored);
const act = (over: Partial<PlanActivity>): PlanActivity => ({ at: "10:30", kind: "do", text: "Spielen mit Kleinkind", ...over });

describe("open-air classification", () => {
  it("uses the index g, then activity places' g, then the name", () => {
    expect(isOpenAirPlace("way/3", c)).toBe(true);
    expect(isOpenAirPlace("way/5", c)).toBe(true);
    expect(isOpenAirPlace("way/8", c)).toBe(true);
    expect(isOpenAirPlace("way/6", c)).toBe(false);
    expect(isOpenAirPlace("way/4", c)).toBe(false); // not a bath
    expect(isOpenAirPlace("node/7", c)).toBe(false);
  });

  it("season: climate month decides, else local winter by latitude", () => {
    expect(outOfSeason("2037-12-23", 48.5, undefined)).toBe(true);
    expect(outOfSeason("2037-07-10", 48.5, undefined)).toBe(false);
    expect(outOfSeason("2037-12-23", 48.5, [{ m: 12, tmax: 3, tmin: -2, wet: 10, sun: 1 }])).toBe(true);
    expect(outOfSeason("2037-06-10", 48.5, [{ m: 6, tmax: 23, tmin: 12, wet: 10, sun: 7 }])).toBe(false);
    expect(outOfSeason(null, 48.5, undefined)).toBe(false);
    expect(winterAt(48, 10)).toBe(true);
    expect(winterAt(40, 10)).toBe(false);
    expect(winterAt(-38, 7)).toBe(true);
    expect(winterAt(20, 1)).toBe(false);
  });
});

describe("guardOpenAir (issue #142)", () => {
  const SUMMER = "2037-07-10";
  it("drops an open-air pool alternative of an indoor activity (text or indoor ref)", () => {
    expect(guardOpenAir(act({ text: "Spielen, drinnen", ref: "way/4", alts: ["way/3"] }), c, SUMMER, undefined)).toEqual({
      act: act({ text: "Spielen, drinnen", ref: "way/4" }),
      dropped: 1,
    });
    expect(guardOpenAir(act({ ref: "node/7", alts: ["way/4", "way/3"] }), c, SUMMER, undefined).act.alts).toEqual(["way/4"]);
  });

  it("replaces an open-air ref by the first remaining alternative, or drops ref and alts", () => {
    expect(guardOpenAir(act({ text: "Bei Regen baden", ref: "way/3", alts: ["way/6", "way/4"] }), c, SUMMER, undefined).act).toEqual(
      act({ text: "Bei Regen baden", ref: "way/6", alts: ["way/4"] }),
    );
    expect(guardOpenAir(act({ text: "Indoor baden", ref: "way/3", alts: ["way/5"] }), c, SUMMER, undefined)).toEqual({
      act: act({ text: "Indoor baden" }),
      dropped: 2,
    });
  });

  it("drops open-air pools out of season, whatever the text", () => {
    const r = guardOpenAir(act({ text: "Spielen zum Abschluss", ref: "way/4", alts: ["way/3"] }), c, "2037-12-23", undefined);
    expect(r).toEqual({ act: act({ text: "Spielen zum Abschluss", ref: "way/4" }), dropped: 1 });
  });

  it("keeps an open-air pool for an outdoor activity in summer, and everything else", () => {
    const summer = act({ text: "Baden im Freibad", ref: "way/3", alts: ["way/5"] });
    expect(guardOpenAir(summer, c, SUMMER, undefined)).toEqual({ act: summer, dropped: 0 });
    const winter = act({ ref: "way/4", alts: ["way/6"] });
    expect(guardOpenAir(winter, c, "2037-12-23", undefined)).toEqual({ act: winter, dropped: 0 });
  });
});
