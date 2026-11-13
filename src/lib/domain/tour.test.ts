import { describe, expect, it } from "vitest";
import {
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
    expect(CORRIDOR_M).toEqual({ foot: 150, wheelchair: 150, cycling: 300, car: 1000 });
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
