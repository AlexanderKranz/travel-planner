import { describe, expect, it } from "vitest";
import { BELVEDERE, HOFBURG, NASCHMARKT, RIESENRAD, STEPHANSDOM, WIEN_CITY } from "./fixtures.test-data";
import { tourCentre, tourPointsOf } from "./points";
import { defaultTitleParts, ownTitle } from "./title";

const places = [{ ...HOFBURG, dwellMin: 60 }, NASCHMARKT];

describe("tourPointsOf", () => {
  it("lists start, places and end with dwell (start/end 0, default for places)", () => {
    const r = tourPointsOf({ places, start: STEPHANSDOM, end: RIESENRAD, dwellDefaultMin: 30 });
    expect(r.points.map((p) => p.key)).toEqual(["osm:w1", "osm:w2", "osm:w3", "osm:n5"]);
    expect(r).toMatchObject({ start: 0, end: 3, dwell: [0, 60, 30, 0] });
  });

  it("round trip uses the start index as end", () => {
    expect(tourPointsOf({ places, start: STEPHANSDOM, end: "start", dwellDefaultMin: 30 })).toMatchObject({
      start: 0,
      end: 0,
    });
    expect(tourPointsOf({ places, start: STEPHANSDOM, end: STEPHANSDOM, dwellDefaultMin: 30 }).points).toHaveLength(3);
  });

  it("without start or end only the places", () => {
    const r = tourPointsOf({ places, dwellDefaultMin: 15 });
    expect(r).toMatchObject({ start: undefined, end: undefined, dwell: [60, 15] });
    expect(tourPointsOf({ places, end: BELVEDERE, dwellDefaultMin: 15 })).toMatchObject({ end: 2 });
  });
});

describe("tourCentre and title", () => {
  it("centre is the city or the mean of the points", () => {
    expect(tourCentre({ city: WIEN_CITY }, [])).toEqual({ lat: WIEN_CITY.lat, lon: WIEN_CITY.lon });
    expect(tourCentre({}, [{ lat: 48, lon: 16 }, { lat: 49, lon: 17 }])).toEqual({ lat: 48.5, lon: 16.5 });
    expect(tourCentre({}, [])).toBeNull();
  });

  it("default title parts and own title", () => {
    expect(defaultTitleParts({ city: WIEN_CITY, places })).toEqual({ city: "Wien", firstPlace: HOFBURG.name });
    expect(defaultTitleParts({ places })).toEqual({ city: null, firstPlace: HOFBURG.name });
    expect(defaultTitleParts({ places: [] })).toEqual({ city: null, firstPlace: null });
    expect(ownTitle({ title: "  " })).toBeNull();
    expect(ownTitle({ title: "Altstadt" })).toBe("Altstadt");
  });
});
