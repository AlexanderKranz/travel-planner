import { describe, expect, it } from "vitest";
import {
  MAX_POINT_KEY,
  MAX_LEG_OVERRIDES,
  MAX_TOUR_PLACES,
  CORRIDOR_M,
  legKey,
  ORS_PROFILE,
  ROUTE_OPTIONS,
  ROUTE_OPTIONS_BY_MODE,
  routeAllowed,
  TOUR_MODES,
  TourDraft,
  TourInput,
  TourResult,
} from "./tour";

const p = (key: string) => ({ key, name: key, lat: 48.2, lon: 16.37, source: "osm" as const });
const base = { places: [p("osm:n1"), p("osm:n2")] };
const ok = (v: object) => TourInput.safeParse({ ...base, ...v }).success;

describe("TourInput", () => {
  it("needs only two places and applies defaults", () => {
    expect(TourInput.parse(base)).toMatchObject({ order: "optimize", mode: "foot", route: "fastest", dwellDefaultMin: 30 });
    expect(TourInput.safeParse({ places: [p("osm:n1")] }).success).toBe(false);
    expect(MAX_TOUR_PLACES).toBe(25); // spec 17.1 [P1]; the cases below derive from it
    expect(TourInput.safeParse({ places: Array.from({ length: MAX_TOUR_PLACES }, (_, i) => p(`osm:n${i}`)) }).success).toBe(true);
    expect(TourInput.safeParse({ places: Array.from({ length: MAX_TOUR_PLACES + 1 }, (_, i) => p(`osm:n${i}`)) }).success).toBe(false);
  });

  it("allows a route only for its modes, also per leg", () => {
    expect(ok({ mode: "foot", route: "green" })).toBe(true);
    expect(ok({ mode: "car", route: "green" })).toBe(false);
    expect(ok({ mode: "car", route: "no_highways" })).toBe(true);
    expect(ok({ mode: "cycling", route: "quiet" })).toBe(true);
    expect(ok({ mode: "wheelchair", route: "no_steps" })).toBe(false);
    expect(ok({ legOverrides: { [legKey("osm:n1", "osm:n2")]: { mode: "cycling", route: "quiet" } } })).toBe(true);
    expect(ok({ legOverrides: { [legKey("osm:n1", "osm:n2")]: { mode: "car", route: "no_steps" } } })).toBe(false);
  });

  it("checks min <= max and endBy after startTime", () => {
    expect(ok({ minMin: 60, maxMin: 60 })).toBe(true);
    expect(ok({ minMin: 90, maxMin: 60 })).toBe(false);
    expect(ok({ endBy: "15:00" })).toBe(false);
    expect(ok({ startTime: "10:00", endBy: "15:00" })).toBe(true);
    expect(ok({ startTime: "10:00", endBy: "10:00" })).toBe(false);
    expect(ok({ startTime: "10:00", endBy: "09:00" })).toBe(false);
    expect(ok({ startTime: "10:00", endBy: "11:00", minMin: 90 })).toBe(false);
    expect(ok({ startTime: "10:00", endBy: "11:30", minMin: 90 })).toBe(true);
    expect(ok({ startTime: "25:00" })).toBe(false);
    expect(ok({ date: "2026-02-31" })).toBe(false);
  });

  it("needs distinct places and a start for a round trip", () => {
    expect(ok({ places: [p("osm:n1"), p("osm:n1")] })).toBe(false);
    expect(ok({ start: p("osm:n1") })).toBe(false);
    expect(ok({ end: "start" })).toBe(false);
    expect(ok({ places: [{ ...p("osm:n1"), key: `gfy:${"5".repeat(120)}` }, p("osm:n2")] })).toBe(true);
    expect(ok({ start: p("geo:1"), end: "start" })).toBe(true);
  });
});

describe("tour constants", () => {
  it("every mode offers fastest and shortest, and only known options", () => {
    for (const m of TOUR_MODES) {
      expect(routeAllowed(m, "fastest") && routeAllowed(m, "shortest")).toBe(true);
      for (const r of ROUTE_OPTIONS_BY_MODE[m]) expect(ROUTE_OPTIONS).toContain(r);
    }
    expect(ORS_PROFILE.cycling).toBe("cycling-regular");
    expect(ORS_PROFILE.ebike).toBe("cycling-electric");
    expect(ROUTE_OPTIONS_BY_MODE.ebike).toEqual(["fastest", "shortest"]);
    expect(CORRIDOR_M).toEqual({ foot: 150, wheelchair: 150, cycling: 300, ebike: 300, car: 1000 });
    expect(legKey("a", "b")).toBe("a>b");
  });

  it("TourResult accepts a snapshot", () => {
    const r = {
      v: 1,
      order: ["osm:n1", "osm:n2"],
      legs: [{ from: "osm:n1", to: "osm:n2", mode: "foot", route: "fastest", min: 5, km: 0.4, poly: "abc", s: "ok" }],
      totalMin: 65,
      fit: "none",
      sights: [],
      source: { ors: "2026-11-12T10:00:00.000Z" },
    };
    expect(TourResult.safeParse(r).success).toBe(true);
    expect(TourResult.safeParse({ ...r, v: 2 }).success).toBe(false);
  });
});

describe("TourDraft (what the browser sends)", () => {
  const d = (key: string) => ({ key, ref: "r" });
  it("carries keys and references only; coordinates are not part of it", () => {
    const parsed = TourDraft.parse({ places: [{ ...d("osm:n1"), lat: 1, lon: 2, name: "x" }, d("osm:n2")] });
    expect(parsed.places[0]).toEqual({ key: "osm:n1", ref: "r" });
  });
  it("applies the same refines as TourInput", () => {
    expect(TourDraft.safeParse({ places: [d("osm:n1"), d("osm:n1")] }).success).toBe(false);
    expect(TourDraft.safeParse({ places: [d("osm:n1"), d("osm:n2")], mode: "car", route: "green" }).success).toBe(false);
    expect(TourDraft.safeParse({ places: [d("osm:n1"), d("osm:n2")], end: "start" }).success).toBe(false);
    expect(TourDraft.safeParse({ places: [d("osm:n1"), d("osm:n2")], start: { key: "geo:1" }, end: "start" }).success).toBe(true);
  });
});

describe("TourDraft leg overrides (writes)", () => {
  const places = Array.from({ length: 25 }, (_, i) => ({ key: `osm:n${i}` }));
  const car = { mode: "car" as const, route: "fastest" as const };
  const pairs = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`osm:n${i % 25}>osm:n${(i + 1 + Math.floor(i / 25)) % 25}`, car]));

  it("accepts up to MAX_LEG_OVERRIDES overrides between the tour's own points", () => {
    expect(MAX_LEG_OVERRIDES).toBe(54);
    expect(TourDraft.safeParse({ places, legOverrides: pairs(MAX_LEG_OVERRIDES) }).success).toBe(true);
    expect(TourDraft.safeParse({ places, legOverrides: pairs(MAX_LEG_OVERRIDES + 1) }).success).toBe(false);
  });

  it("a worst-case input (maximum keys and names, 27 points, the full override cap) fits the 32 kB input check", () => {
    const pt = (i: number) => ({ key: `osm:n${String(i).padStart(3, "0")}`.padEnd(MAX_POINT_KEY, "x"), name: "N".repeat(120), lat: -89.123456789, lon: -179.123456789, source: "geoapify" as const, cat: "c".repeat(40), dwellMin: 480 });
    const all = Array.from({ length: 27 }, (_, i) => pt(i));
    const legOverrides = Object.fromEntries(
      Array.from({ length: MAX_LEG_OVERRIDES }, (_, i) => [`${all[i % 27].key}>${all[(i + 1 + Math.floor(i / 27)) % 27].key}`, { mode: "car", route: "no_highways" }]),
    );
    const input = TourInput.parse({ title: "T".repeat(120), city: pt(99), start: all[0], end: all[26], places: all.slice(1, 26), legOverrides, date: "2030-01-01", startTime: "10:00", endBy: "18:00", minMin: 60, maxMin: 600 });
    expect(Object.keys(input.legOverrides ?? {})).toHaveLength(MAX_LEG_OVERRIDES);
    expect(new TextEncoder().encode(JSON.stringify(input)).length).toBeLessThan(32768);
  });

  it("refuses more on write; stored inputs are not re-checked", () => {
    const many = Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`osm:n${i % 25}>osm:x${i}`, car]));
    expect(TourDraft.safeParse({ places, legOverrides: many }).success).toBe(false);
    expect(TourInput.safeParse({ places: places.map((x) => p(x.key)), legOverrides: many }).success).toBe(true);
  });
});
