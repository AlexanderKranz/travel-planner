import { describe, expect, it } from "vitest";
import type { PlanDay } from "@/lib/domain/plan";
import { RIESENRAD } from "@/lib/tour/fixtures.test-data";
import { sketchGeometry } from "@/lib/tour/sketch";
import { mergeDayRows, type FixedItem, type FixedSlot } from "./fixed-items";
import {
  addMinutes,
  hasAddressEnds,
  planKeyOf,
  tourBlockOf,
  tourBlocks,
  tourSlots,
  tourSlotTitle,
  tourStopKeys,
  toursChangedSince,
  toursWithoutDay,
  visitOrder,
  withTourSlots,
} from "./tour-blocks";
import { linkedTour, wienInput, wienResult } from "./tour-test-helpers";

describe("tour slots (plan input, city-tour 10)", () => {
  it("a linked tour with a start time and a result enters fixed as an activity", () => {
    expect(tourSlots([linkedTour()], 5, "de")).toEqual([
      { day: 2, from: "10:00", to: "12:10", cat: "activity", title: "Stadttour: Hofburg, Stephansdom, Naschmarkt" },
    ]);
    expect(tourSlots([linkedTour()], 5, "en")[0]!.title).toBe("City tour: Hofburg, Stephansdom, Naschmarkt");
  });
  it("is not sent without a start time, without a result total, or without a day of the trip", () => {
    expect(tourSlots([linkedTour({ input: wienInput() })], 5, "de")).toEqual([]);
    expect(tourSlots([linkedTour({ result: null })], 5, "de")).toEqual([]);
    expect(tourSlots([linkedTour({ result: wienResult({ totalMin: null }) })], 5, "de")).toEqual([]);
    expect(tourSlots([linkedTour({ tripDay: null }), linkedTour({ tripDay: 6 })], 5, "de")).toEqual([]);
  });
  it("cuts the title to 60 characters like an item title", () => {
    const many = wienInput({
      places: Array.from({ length: 8 }, (_, i) => ({ key: `osm:n${i + 10}`, name: `Sehenswürdigkeit ${i + 1}`, lat: 48.2, lon: 16.37, source: "osm" as const })),
    });
    const title = tourSlotTitle(many, null, "de");
    expect(title).toHaveLength(60);
    expect(title.startsWith("Stadttour: Sehenswürdigkeit 1, Sehenswürdigkeit 2")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
  });
  it("start and end are no places of the title; a round trip is fine", () => {
    const input = wienInput({ start: RIESENRAD, end: "start", startTime: "09:00" });
    const result = wienResult({ order: [RIESENRAD.key, "osm:w2", "osm:w1", "osm:w3", RIESENRAD.key] });
    expect(tourSlotTitle(input, result, "de")).toBe("Stadttour: Hofburg, Stephansdom, Naschmarkt");
    expect(visitOrder(input, result).map((p) => p.name)).toEqual(["Riesenrad", "Hofburg", "Stephansdom", "Naschmarkt", "Riesenrad"]);
  });
  it("past midnight the end wraps (ends the next day)", () => {
    expect(addMinutes("22:30", 120)).toBe("00:30");
    expect(tourSlots([linkedTour({ input: wienInput({ startTime: "23:00" }) })], 5, "de")[0]).toMatchObject({ from: "23:00", to: "01:10" });
  });
  it("merges with item slots in day/start order; without tours the item slots are the same object", () => {
    const items: FixedSlot[] = [
      { day: 1, from: "13:00", to: "16:00", cat: "flight" },
      { day: 2, from: "10:00", cat: "food", title: "Brunch" },
    ];
    expect(withTourSlots(items, [])).toBe(items);
    expect(withTourSlots(undefined, [])).toBeUndefined();
    const merged = withTourSlots(items, tourSlots([linkedTour()], 5, "de"))!;
    expect(merged.map((s) => `${s.day} ${s.from} ${s.cat}`)).toEqual(["1 13:00 flight", "2 10:00 food", "2 10:00 activity"]);
  });
});

describe("tour blocks (render)", () => {
  it("block of a tour: time range, place count, km, stop names in visiting order, sketch", () => {
    expect(tourBlockOf(linkedTour(), 5)).toMatchObject({
      day: 2,
      from: "10:00",
      to: "12:10",
      placeCount: 3,
      km: 1.6,
      mode: "foot",
      stops: ["Hofburg", "Stephansdom", "Naschmarkt"],
      addressEnds: false,
    });
    expect(tourBlockOf(linkedTour(), 5)!.sketch!.points.map((p) => p.n)).toEqual([1, 2, 3]);
  });
  it("a result for removed places falls back to the input order and still gives a block", () => {
    const b = tourBlockOf(linkedTour({ result: wienResult({ order: ["osm:w9", "osm:w1"] }) }), 5)!;
    expect(b.stops).toEqual(["Stephansdom", "Hofburg", "Naschmarkt"]);
  });
  it("a place added since the computation is not left out: the input order is used", () => {
    const input = wienInput({ startTime: "10:00", places: [...wienInput().places, RIESENRAD] });
    expect(tourBlockOf(linkedTour({ input }), 5)!.stops).toEqual(["Stephansdom", "Hofburg", "Naschmarkt", "Riesenrad"]);
    expect(tourSlotTitle(input, wienResult(), "de")).toBe("Stadttour: Stephansdom, Hofburg, Naschmarkt, Riesenrad");
  });
  it("no km when a leg has none; dashed legs for a per-leg mode", () => {
    const r = wienResult();
    const legs = [{ ...r.legs[0]!, km: null }, { ...r.legs[1]!, mode: "cycling" as const }];
    const b = tourBlockOf(linkedTour({ result: { ...r, legs } }), 5)!;
    expect(b.km).toBeNull();
    expect(b.sketch!.legs.map((l) => l.dashed ?? false)).toEqual([false, true]);
  });
  it("tours beyond the trip length or without a day are 'Ohne Tag' and get no block", () => {
    const tours = [linkedTour({ id: "a", tripDay: 6 }), linkedTour({ id: "b", tripDay: null }), linkedTour({ id: "c" })];
    expect(tourBlocks(tours, 5).map((b) => b.id)).toEqual(["c"]);
    expect(toursWithoutDay(tours, 5).map((t) => t.id)).toEqual(["a", "b"]);
  });
  it("several tours: by day, untimed first, then by start", () => {
    const tours = [
      linkedTour({ id: "late", input: wienInput({ startTime: "15:00" }) }),
      linkedTour({ id: "none", input: wienInput() }),
      linkedTour({ id: "early", input: wienInput({ startTime: "09:00" }) }),
      linkedTour({ id: "day1", tripDay: 1 }),
    ];
    expect(tourBlocks(tours, 5).map((b) => b.id)).toEqual(["day1", "none", "early", "late"]);
  });
  it("address ends: a Geoapify start or end without an OSM POI", () => {
    const home = { key: "gfy:0123456789abcdef0123456789abcdef", name: "Musterstraße 1", lat: 48.2, lon: 16.36, source: "geoapify" as const };
    expect(hasAddressEnds(wienInput({ start: home }))).toBe(true);
    expect(hasAddressEnds(wienInput({ start: RIESENRAD, end: home }))).toBe(true);
    expect(hasAddressEnds(wienInput({ start: RIESENRAD, end: "start" }))).toBe(false);
    expect(hasAddressEnds(wienInput())).toBe(false);
  });
});

describe("merge rule with tours (timed-items [D7])", () => {
  const day: PlanDay = {
    n: 2,
    date: null,
    title: "Wien",
    stops: [
      { place: "Wien", acts: [{ at: "09:00", kind: "food", text: "Frühstück" }, { kind: "travel", text: "Weg" }, { at: "14:00", kind: "see", text: "Prater" }] },
      { place: "Abend", acts: [{ at: "19:00", kind: "food", text: "Essen" }] },
    ],
  };
  const item: FixedItem = { id: "i", day: 2, from: "10:00", category: "food", title: "Brunch", status: "booked" };
  const rows = (fixed: FixedItem[], tours = tourBlocks([linkedTour()], 5)) =>
    mergeDayRows(day, fixed, tours).map((s) => s.rows.map((r) => (r.kind === "act" ? r.act.text : r.kind === "fixed" ? `F:${r.item.id}` : `T:${r.tour.from ?? "-"}`)));

  it("a timed tour goes before the first activity at or after its start; an item with the same start comes first", () => {
    expect(rows([item])).toEqual([["Frühstück", "F:i", "T:10:00", "Weg", "Prater"], ["Essen"]]);
  });
  it("an untimed tour goes to the top of the day; a late tour to the end of the last stop", () => {
    const tours = tourBlocks([linkedTour({ id: "u", input: wienInput() }), linkedTour({ id: "l", input: wienInput({ startTime: "21:00" }) })], 5);
    expect(rows([], tours)).toEqual([["T:-", "Frühstück", "Weg", "Prater"], ["Essen", "T:21:00"]]);
  });
  it("without tours the rows are as before", () => {
    expect(rows([item], [])).toEqual([["Frühstück", "F:i", "Weg", "Prater"], ["Essen"]]);
  });
});

describe("tour stops for the duplicate guard", () => {
  it("maps OSM tour keys to plan keys, per trip day, for tours with or without a start time", () => {
    expect(planKeyOf("osm:n5")).toBe("node/5");
    expect(planKeyOf("osm:w12")).toBe("way/12");
    expect(planKeyOf("osm:r7")).toBe("relation/7");
    expect(planKeyOf("gfy:abc")).toBeNull();
    expect(planKeyOf("geo:2761369")).toBeNull();
    const tours = [
      linkedTour({ input: wienInput({ start: RIESENRAD }) }),
      linkedTour({ id: "b", tripDay: 3, input: wienInput() }),
      linkedTour({ id: "c", tripDay: 9 }),
    ];
    expect(tourStopKeys(tours, 5)).toEqual({ "2": ["node/5", "way/1", "way/2", "way/3"], "3": ["way/1", "way/2", "way/3"] });
    expect(tourStopKeys([], 5)).toBeUndefined();
  });
});

describe("outdated hint", () => {
  it("a tour with day and start time changed after the version", () => {
    const at = "2026-11-12T09:00:00.000Z";
    expect(toursChangedSince([linkedTour({ updatedAt: "2026-11-12T10:00:00.000Z" })], 5, at)).toBe(true);
    expect(toursChangedSince([linkedTour({ updatedAt: "2026-11-12T08:00:00.000Z" })], 5, at)).toBe(false);
    expect(toursChangedSince([linkedTour({ input: wienInput(), updatedAt: "2026-11-12T10:00:00.000Z" })], 5, at)).toBe(false);
    expect(toursChangedSince([linkedTour({ tripDay: 7, updatedAt: "2026-11-12T10:00:00.000Z" })], 5, at)).toBe(false);
  });
});

describe("sketch geometry", () => {
  it("projects legs and stops into the box, keeps the aspect, numbers the dots", () => {
    const b = tourBlockOf(linkedTour(), 5)!;
    const g = sketchGeometry(b.sketch!.legs, b.sketch!.points, 320, 200, 10)!;
    expect(g.paths).toHaveLength(2);
    expect(g.paths[0]!.d).toMatch(/^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
    for (const d of g.dots) {
      expect(d.x).toBeGreaterThanOrEqual(10);
      expect(d.x).toBeLessThanOrEqual(310);
      expect(d.y).toBeGreaterThanOrEqual(10);
      expect(d.y).toBeLessThanOrEqual(190);
    }
    expect(g.dots.map((d) => d.n)).toEqual([1, 2, 3]);
    // North is up: Naschmarkt (south) is lower than Stephansdom.
    expect(g.dots[2]!.y).toBeGreaterThan(g.dots[1]!.y);
  });
  it("a damaged polyline costs its line, not the sketch; nothing at all gives null", () => {
    const g = sketchGeometry([{ poly: "\u0000bad" }], [{ lat: 48.2, lon: 16.37 }], 100, 100)!;
    expect(g.paths).toEqual([]);
    expect(g.dots).toEqual([{ x: 50, y: 50 }]);
    expect(sketchGeometry([], [], 100, 100)).toBeNull();
  });
});
