import { describe, expect, it } from "vitest";
import type { TripStop } from "@/lib/domain/trip-stops";
import { DESTINATION_KM, MAX_GEOCODED_NAMES, MAX_STOPS, assignStops, distinctStopNames, namesToGeocode, stopKey, stopOfRow, type GeocodeOutcome } from "./stops-resolve";
import { CRUISE_STOPS, DURNSTEIN, PASSAU, WIEN } from "./stops-test-helpers";

const ok = (name: string, p: { lat: number; lon: number; geoId: number }): GeocodeOutcome => ({ status: "ok", name, point: p });
const outcomes = (entries: [string, GeocodeOutcome][]) => new Map(entries.map(([k, v]) => [stopKey(k), v]));

describe("distinctStopNames", () => {
  it("lists each place once in day order, never sea days, accents and case ignored", () => {
    const names = distinctStopNames([...CRUISE_STOPS, { day: 6, place: "DURNSTEIN" }]);
    expect(names.map((n) => n.name)).toEqual(["Passau", "Wien", "Dürnstein"]);
  });
  it("keeps the first cc", () => {
    expect(distinctStopNames([{ day: 1, place: "Wien", cc: "AT" }, { day: 2, place: "wien", cc: "DE" }])).toEqual([{ key: "wien", name: "Wien", cc: "AT" }]);
  });
  it("namesToGeocode stops at MAX_GEOCODED_NAMES", () => {
    const many: TripStop[] = Array.from({ length: 30 }, (_, i) => ({ day: i + 1, place: `Ort${i}` }));
    expect(namesToGeocode(many)).toHaveLength(MAX_GEOCODED_NAMES);
  });
});

describe("assignStops (docs/specs/port-places.md section 1)", () => {
  const found = outcomes([
    ["Passau", ok("Passau", PASSAU)],
    ["Wien", ok("Wien", WIEN)],
    ["Dürnstein", ok("Dürnstein", DURNSTEIN)],
  ]);

  it("the cruise example: Passau is the destination on days 1 and 5, Wien s1, Dürnstein s2", () => {
    const r = assignStops(CRUISE_STOPS, found, { lat: 48.5665, lon: 13.43122 });
    expect(r.map((x) => [x.id, x.role, x.days, x.status])).toEqual([
      ["dest", "destination", [1, 5], "ok"],
      ["s1", "stop", [2], "ok"],
      ["s2", "stop", [3], "ok"],
    ]);
  });

  it("a stop within 5 km of the anchor is the destination, one further out is a stop", () => {
    const near = { lat: PASSAU.lat + 0.03, lon: PASSAU.lon, geoId: 1 }; // ~3.3 km
    const far = { lat: PASSAU.lat + 0.06, lon: PASSAU.lon, geoId: 2 }; // ~6.7 km
    const r = assignStops(
      [{ day: 1, place: "Nah" }, { day: 2, place: "Fern" }],
      outcomes([["Nah", ok("Nah", near)], ["Fern", ok("Fern", far)]]),
      PASSAU,
    );
    expect(DESTINATION_KM).toBe(5);
    expect(r.map((x) => [x.id, x.role])).toEqual([["dest", "destination"], ["s1", "stop"]]);
  });

  it("without an anchor (free-text destination) every place is a stop", () => {
    const r = assignStops(CRUISE_STOPS, found, null);
    expect(r.map((x) => x.id)).toEqual(["s1", "s2", "s3"]);
    expect(r[0].name).toBe("Passau");
  });

  it("the same port on two days, and two spellings of one place, are one stop", () => {
    const r = assignStops(
      [{ day: 2, place: "Wien" }, { day: 4, place: "Vienna" }, { day: 6, place: "Wien" }],
      outcomes([["Wien", ok("Wien", WIEN)], ["Vienna", ok("Wien", WIEN)]]),
      null,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: "s1", days: [2, 4, 6] });
    expect(r[0].keys).toEqual(["wien", "vienna"]);
  });

  it("Dürnstein and Melk on one day are two stops", () => {
    const melk = { lat: 48.2276, lon: 15.3328, geoId: 2767385 };
    const r = assignStops([{ day: 3, place: "Dürnstein" }, { day: 3, place: "Melk" }], outcomes([["Dürnstein", ok("Dürnstein", DURNSTEIN)], ["Melk", ok("Melk", melk)]]), null);
    expect(r.map((x) => [x.id, x.name, x.days])).toEqual([["s1", "Dürnstein", [3]], ["s2", "Melk", [3]]]);
  });

  it("not found and geocoding errors are stops with that status and no point; the id still counts", () => {
    const r = assignStops(
      [{ day: 1, place: "Nirgendwo" }, { day: 2, place: "Wien" }, { day: 3, place: "Kaputt" }],
      outcomes([["Nirgendwo", { status: "not_found" }], ["Wien", ok("Wien", WIEN)], ["Kaputt", { status: "error" }]]),
      null,
    );
    expect(r.map((x) => [x.id, x.status, !!x.point])).toEqual([["s1", "not_found", false], ["s2", "ok", true], ["s3", "error", false]]);
    expect(r[0].name).toBe("Nirgendwo");
  });

  it("[P6] the first 10 found stops are ok, later ones cap; a name never geocoded is cap", () => {
    const rows: TripStop[] = Array.from({ length: 13 }, (_, i) => ({ day: i + 1, place: `Ort${i}` }));
    const map = outcomes(rows.slice(0, 12).map((r, i): [string, GeocodeOutcome] => [r.place!, ok(r.place!, { lat: 10 + i, lon: 10, geoId: 1000 + i })]));
    const r = assignStops(rows, map, null);
    expect(MAX_STOPS).toBe(10);
    expect(r.filter((x) => x.status === "ok")).toHaveLength(10);
    expect(r.slice(10).map((x) => [x.id, x.status, !!x.point])).toEqual([["s11", "cap", false], ["s12", "cap", false], ["s13", "cap", false]]);
  });

  it("a stop seen again on a later day is still ok after the cap is reached", () => {
    const rows: TripStop[] = [...Array.from({ length: 10 }, (_, i) => ({ day: i + 1, place: `Ort${i}` })), { day: 11, place: "Extra" }, { day: 12, place: "Ort0" }];
    const map = outcomes([...rows.slice(0, 11).map((r, i): [string, GeocodeOutcome] => [r.place!, ok(r.place!, { lat: 10 + i, lon: 10, geoId: 1000 + i })])]);
    const r = assignStops(rows, map, null);
    expect(r.find((x) => x.name === "Ort0")!.days).toEqual([1, 12]);
    expect(r.find((x) => x.name === "Extra")!.status).toBe("cap");
  });

  it("stopOfRow finds the stop of a typed row by name, not for sea rows", () => {
    const r = assignStops(CRUISE_STOPS, found, PASSAU);
    expect(stopOfRow({ place: "Wien" }, r)?.id).toBe("s1");
    expect(stopOfRow({ place: "passau" }, r)?.id).toBe("dest");
    expect(stopOfRow({ sea: true }, r)).toBeUndefined();
  });
});
