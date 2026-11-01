import { describe, expect, it } from "vitest";
import type { GeoPlace } from "@/lib/domain";
import { cleanAirportCity, pickHomeSuggestion, shouldSuggestHome } from "./home-suggestion";

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
      geoId: 1, // the server resolves the coordinates from it
    });
  });
  it("prefers the most populous populated place, not the closest", () => {
    const hill = place({ geoId: 2, name: "Zürichberg", featureCode: "PPLX", population: 500, lat: 50.03, lon: 8.57 });
    const city = place({ geoId: 3, name: "Zürich", population: 400000, lat: 50.1, lon: 8.7 });
    expect(pickHomeSuggestion(fra, [hill, city], "de")?.name).toMatch(/^Zürich,/);
  });
  it("skips airports and other non-populated features", () => {
    const airport = place({ featureCode: "AIRP", name: "Flughafen Düsseldorf" });
    expect(pickHomeSuggestion(fra, [airport, place({ featureCode: "HLL" })], "de")).toBeNull();
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

describe("cleanAirportCity", () => {
  it("strips parentheticals and takes the part before ' / '", () => {
    expect(cleanAirportCity("Frankfurt am Main (Lautzenhausen)")).toBe("Frankfurt am Main");
    expect(cleanAirportCity("Bâle / Mulhouse")).toBe("Bâle");
    expect(cleanAirportCity("Köln (Cologne)")).toBe("Köln");
    expect(cleanAirportCity("Málaga")).toBe("Málaga");
  });
});
