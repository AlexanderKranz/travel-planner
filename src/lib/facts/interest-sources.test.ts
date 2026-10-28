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

  it("builds a stable query", () => {
    const src = INTEREST_SOURCES.golf;
    if (src.source !== "osm") throw new Error("golf must be osm");
    expect(buildQuery(src.filters, { lat: 36.51543, lon: -4.88583 }, 40000)).toBe(
      '[out:json][timeout:25];\n(\n  nwr["leisure"="golf_course"]["golf"!~"^(driving_range|practice)$"]["name"](around:40000,36.51543,-4.88583);\n);\nout center tags 150;',
    );
  });
});
