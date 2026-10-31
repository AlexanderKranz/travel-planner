import { describe, expect, it } from "vitest";
import type { GeoPlace } from "@/lib/domain";
import { pickHomeSuggestion, shouldSuggestHome } from "./home-suggestion";

const fra = { city: "Frankfurt am Main", country: "DE", lat: 50.03, lon: 8.57 };
const place = (o: Partial<GeoPlace>): GeoPlace => ({
  geoId: 1,
  name: "Frankfurt am Main",
  featureCode: "PPLA",
  countryCode: "DE",
  admin1: "Hessen",
  lat: 50.11,
  lon: 8.68,
  timezone: "Europe/Berlin",
  population: 700000,
  suggestedKind: "city",
  ...o,
});

describe("pickHomeSuggestion", () => {
  it("returns the place with its validated zone", () => {
    expect(pickHomeSuggestion(fra, [place({})], "de")).toEqual({
      name: "Frankfurt am Main, Hessen, Deutschland",
      timezone: "Europe/Berlin",
    });
  });
  it("picks the nearest hit in the same country", () => {
    const far = place({ geoId: 2, lat: 53.5, lon: 10 });
    const near = place({ geoId: 3, name: "Frankfurt", lat: 50.1, lon: 8.7 });
    expect(pickHomeSuggestion(fra, [far, near], "de")?.name).toMatch(/^Frankfurt,/);
  });
  it("ignores other countries, far places, missing and invalid zones", () => {
    expect(pickHomeSuggestion(fra, [place({ countryCode: "US" })], "de")).toBeNull();
    expect(pickHomeSuggestion(fra, [place({ lat: 40, lon: -74 })], "de")).toBeNull();
    expect(pickHomeSuggestion(fra, [place({ timezone: null })], "de")).toBeNull();
    expect(pickHomeSuggestion(fra, [place({ timezone: "Nope/Nope" })], "de")).toBeNull();
    expect(pickHomeSuggestion(fra, [], "de")).toBeNull();
  });
});

describe("shouldSuggestHome", () => {
  it("only without a home and with at least one airport", () => {
    expect(shouldSuggestHome(null, ["FRA"])).toBe(true);
    expect(shouldSuggestHome(null, [])).toBe(false);
    expect(shouldSuggestHome({ name: "Wien", timezone: "Europe/Vienna" }, ["FRA"])).toBe(false);
  });
});
