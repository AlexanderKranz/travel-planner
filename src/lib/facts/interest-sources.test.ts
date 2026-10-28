import { describe, expect, it } from "vitest";
import { INTEREST_KEYS } from "@/lib/domain/interests";
import { buildQuery } from "../integrations/overpass";
import { INTEREST_SOURCES, interestsForTrip, radiusForInterest } from "./interest-sources";
import { vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("interest sources", () => {
  it("maps every interest key", () => {
    for (const k of INTEREST_KEYS) expect(INTEREST_SOURCES[k]).toBeDefined();
  });

  it("defaults to general without purpose or known interests", () => {
    expect(interestsForTrip(null)).toEqual({ keys: ["general"], customInterests: [] });
    expect(interestsForTrip({ interests: ["Pilze sammeln"] })).toEqual({ keys: ["general"], customInterests: ["Pilze sammeln"] });
  });

  it("keeps order, dedupes, separates custom text and caps OSM queries at 4", () => {
    const r = interestsForTrip({
      interests: ["golf", "cruise", "golf", "beach", "x", "museums", "history", "hiking", "nightlife"],
    });
    expect(r.keys).toEqual(["golf", "cruise", "beach", "museums", "history", "nightlife"]);
    expect(r.customInterests).toEqual(["x"]);
  });

  it("radius: max(trip, minimum), capped at 60", () => {
    expect(radiusForInterest("golf", 15)).toBe(40);
    expect(radiusForInterest("beach", 15)).toBe(15);
    expect(radiusForInterest("skiing", 100)).toBe(60);
  });

  it("builds a stable bbox query", () => {
    const src = INTEREST_SOURCES.golf;
    if (src.source !== "osm") throw new Error("golf must be osm");
    const bb = "36.15611,-5.33292,36.87475,-4.43874";
    expect(buildQuery(src.filters, { lat: 36.51543, lon: -4.88583 }, 40000)).toBe(
      `[out:json][timeout:90];
(
  nwr["leisure"="golf_course"]["golf"!~"^(driving_range|practice)$"]["name"](${bb});
);
out center tags 150;`,
    );
  });
});

describe("interestsForTrip with purpose tags (phase 3)", () => {
  it("appends tag interests after guided keys, still capped at 4 OSM queries", () => {
    const r = interestsForTrip(
      { interests: ["golf", "beach", "museums"] },
      { interests: ["beach", "history", "hiking", "christmas_markets"] },
    );
    expect(r.keys).toEqual(["golf", "beach", "museums", "history", "christmas_markets"]);
  });

  it("uses tag interests when nothing is guided", () => {
    expect(interestsForTrip(null, { interests: ["golf"] }).keys).toEqual(["golf", "general"]);
  });

  it("adds general when all keys come from tags", () => {
    expect(interestsForTrip({}, { interests: ["christmas_markets"] }).keys).toEqual(["christmas_markets", "general"]);
    // guided no-source keys stay as chosen
    expect(interestsForTrip({ interests: ["christmas_markets"] }, { interests: [] }).keys).toEqual(["christmas_markets"]);
  });

  it("ignores unknown tag keys and null tags", () => {
    expect(interestsForTrip(null, { interests: ["golfing" as never] }).keys).toEqual(["general"]);
    expect(interestsForTrip(null, { interests: ["golf", "beach", "museums", "history", "hiking"] }).keys).toEqual([
      "golf",
      "beach",
      "museums",
      "history",
      "general",
    ]);
    expect(interestsForTrip({ interests: ["golf"] }, null).keys).toEqual(["golf"]);
  });
});
