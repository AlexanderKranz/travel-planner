import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock("./http", async (orig) => ({ ...(await orig<typeof import("./http")>()), fetchJson: h.fetchJson }));

import {
  AUTOCOMPLETE_TIMEOUT_MS,
  autocompleteUrl,
  fetchAutocomplete,
  fetchPlaceDetails,
  gfyKey,
  isTourPoi,
  parseAutocomplete,
  parsePlaceDetails,
  placeDetailsUrl,
} from "./geoapify-autocomplete";

/** Recorded live 2026-11-12 (city tour spike): "Stephansdom" around Wien, lang de; details of the first result. */
const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, "__fixtures__/geoapify-autocomplete", `${name}.json`), "utf8"));
const auto = fx("autocomplete-stephansdom-wien-de");
const details = fx("place-details-stephansdom-de");

beforeEach(() => {
  h.fetchJson.mockReset();
  vi.stubEnv("GEOAPIFY_API_KEY", "gk");
});
afterEach(() => vi.unstubAllEnvs());

describe("Geoapify autocomplete", () => {
  it("URL: normalized text, 20 km circle and proximity bias on the 2-decimal cell, lang, 8 results, json", () => {
    const u = new URL(autocompleteUrl("  Stephans  DOM ", { lat: 48.2085, lon: 16.3731 }, "de", "gk"));
    expect(`${u.origin}${u.pathname}`).toBe("https://api.geoapify.com/v1/geocode/autocomplete");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      text: "stephans dom",
      filter: "circle:16.37,48.21,20000",
      bias: "proximity:16.37,48.21",
      lang: "de",
      limit: "8",
      format: "json",
      apiKey: "gk",
    });
  });

  it("parses the recorded 5 results into 4: the duplicate 'Stephansdom Krypta' (same node twice) is dropped", () => {
    const s = parseAutocomplete(auto);
    expect(s.map((x) => [x.name, x.datasource])).toEqual([
      ["Stephansdom", "openstreetmap"],
      ["Stephansdom Krypta", "openstreetmap"],
      ["Stephansdom", "whosonfirst"], // same name, 435 m away: a different place (the neighbourhood)
      ["Hotel SOFITEL VIENNA STEPHANSDOM", "geonames"],
    ]);
    expect(s[0]).toMatchObject({
      lat: 48.2084923,
      lon: 16.3731269,
      address: "Stephansplatz 3, 1010 Wien, Österreich",
      distanceM: 2,
    });
    expect(s[0].category).toBeUndefined();
    expect(s[1].category).toBe("tourism.attraction");
  });

  it("keys are gfy: + 32 hex of the place_id (fits the 40-character tour key), stable and distinct", () => {
    const s = parseAutocomplete(auto);
    for (const x of s) {
      expect(x.key).toMatch(/^gfy:[0-9a-f]{32}$/);
      expect(x.key).toBe(gfyKey(x.placeId));
      expect(x.placeId.length).toBeGreaterThan(40);
    }
    expect(new Set(s.map((x) => x.key)).size).toBe(s.length);
  });

  it("skips malformed results instead of repairing them; none usable or no results array is a shape error", () => {
    const bad = [{ name: "x", lat: 1, lon: 2 }, { place_id: "abcdef0123", lat: 99, lon: 2, name: "bad lat" }, { place_id: "abcdef0123", lat: 1, lon: 2 }];
    const good = { place_id: "abcdef0123", lat: 1, lon: 2, name: "Ok" };
    expect(parseAutocomplete({ results: [...bad, good] }).map((s) => s.name)).toEqual(["Ok"]);
    expect(() => parseAutocomplete({ results: bad })).toThrow();
    expect(parseAutocomplete({ results: [] })).toEqual([]); // no match is a real answer
    expect(() => parseAutocomplete({ features: [] })).toThrow();
  });

  it("a body that fails to parse still carries its credit (units: 1) for the quota guard", async () => {
    h.fetchJson.mockResolvedValue({ status: 200, latencyMs: 5, body: { features: [] } });
    await expect(fetchAutocomplete({ q: "Stephansdom", lat: 1, lon: 2, lang: "de" })).rejects.toMatchObject({ units: 1 });
    await expect(fetchPlaceDetails("abcdef0123", "de")).rejects.toMatchObject({ units: 1 });
  });

  it("fetchAutocomplete: one GET with the short timeout; refuses short queries, a bad lang and a missing key", async () => {
    h.fetchJson.mockResolvedValue({ status: 200, latencyMs: 570, body: auto });
    const r = await fetchAutocomplete({ q: "Stephansdom", lat: 48.2085, lon: 16.3731, lang: "de" });
    expect(r.suggestions).toHaveLength(4);
    expect(h.fetchJson).toHaveBeenCalledWith(expect.stringContaining("text=stephansdom"), { timeoutMs: AUTOCOMPLETE_TIMEOUT_MS });
    await expect(fetchAutocomplete({ q: " St ", lat: 1, lon: 2, lang: "de" })).rejects.toThrow(RangeError);
    await expect(fetchAutocomplete({ q: "Stephansdom", lat: 1, lon: 2, lang: "deu" })).rejects.toThrow(RangeError);
    vi.stubEnv("GEOAPIFY_API_KEY", "");
    await expect(fetchAutocomplete({ q: "Stephansdom", lat: 1, lon: 2, lang: "de" })).rejects.toThrow("GEOAPIFY_API_KEY missing");
    expect(h.fetchJson).toHaveBeenCalledTimes(1);
  });
});

describe("Geoapify place details", () => {
  it("URL: id and lang", () => {
    const u = new URL(placeDetailsUrl("51d0dc", "en", "gk"));
    expect(`${u.origin}${u.pathname}`).toBe("https://api.geoapify.com/v2/place-details");
    expect(Object.fromEntries(u.searchParams)).toEqual({ id: "51d0dc", lang: "en", apiKey: "gk" });
  });

  it("resolves the OSM way, category, raw opening hours and Wikidata from datasource.raw", () => {
    expect(parsePlaceDetails(details, "de")).toEqual({
      osmKey: "osm:w212496461",
      name: "Stephansdom",
      lat: 48.2084923,
      lon: 16.3731269,
      cat: "place_of_worship",
      openingHours: "Mo-Sa 06:00-22:00; Su 07:00-22:00",
      wikidata: "Q5943",
    });
    expect(parsePlaceDetails(details, "en").name).toBe("Saint Stephen's Cathedral");
  });

  it("node and relation keys; non-OSM sources have no osm key", () => {
    const one = (raw: Record<string, unknown>, sourcename = "openstreetmap") => ({
      features: [{ properties: { name: "P", lat: 1, lon: 2, datasource: { sourcename, raw } } }],
    });
    expect(parsePlaceDetails(one({ osm_type: "n", osm_id: 4543089891 }), "de").osmKey).toBe("osm:n4543089891");
    expect(parsePlaceDetails(one({ osm_type: "r", osm_id: 7 }), "de").osmKey).toBe("osm:r7");
    expect(parsePlaceDetails(one({ osm_type: "x", osm_id: 7 }), "de").osmKey).toBeNull();
    expect(parsePlaceDetails(one({ osm_type: "n", osm_id: 7 }, "whosonfirst"), "de")).toEqual({ osmKey: null, name: "P", lat: 1, lon: 2 });
    // An over-long opening_hours tag is dropped, never cut (a cut rule can lose an exception).
    expect(parsePlaceDetails(one({ osm_type: "n", osm_id: 7, opening_hours: `Mo-Fr 09:00-18:00; ${"x".repeat(250)}` }), "de").openingHours).toBeUndefined();
    expect(() => parsePlaceDetails({ type: "FeatureCollection", features: [] }, "de")).toThrow();
  });

  it("fetchPlaceDetails validates the id before calling", async () => {
    h.fetchJson.mockResolvedValue({ status: 200, latencyMs: 680, body: details });
    const id = details.features[0].properties.place_id as string;
    expect((await fetchPlaceDetails(id, "de")).details.osmKey).toBe("osm:w212496461");
    await expect(fetchPlaceDetails("../../v1/x?y", "de")).rejects.toThrow();
    expect(h.fetchJson).toHaveBeenCalledTimes(1);
  });
});

/**
 * Recorded live 2026-11-12 (landmark fix, issue #172): `type=amenity`, lang de, 20 km around Frankfurt
 * (50.12,8.68) for the five queries Alex tested.
 */
describe("POI mode (tour places)", () => {
  const amenity = (q: string) => fx(`amenity-${q}-frankfurt-de`);

  it("URL: type=amenity only in poi mode", () => {
    const at = { lat: 50.11552, lon: 8.68417 };
    expect(new URL(autocompleteUrl("dom", at, "de", "gk", "poi")).searchParams.get("type")).toBe("amenity");
    expect(new URL(autocompleteUrl("dom", at, "de", "gk", "any")).searchParams.has("type")).toBe(false);
    expect(new URL(autocompleteUrl("dom", at, "de", "gk")).searchParams.has("type")).toBe(false);
  });

  it.each([
    ["dom", ["Dominikanerkloster", "Dom/Römer", "Kaiserdom St. Bartholomäus", "Dommuseum"]],
    ["kaiserdom", ["Kaiserdom St. Bartholomäus"]],
    ["alte-oper", ["Alte Oper", "Alte Oper", "Holiday Inn Frankfurt - Alte Oper"]],
    ["hauptbahnhof", ["Hauptbahnhof", "Hauptbahnhof (tief)", "Hauptbahnhof Südseite", "Hauptbahnhof"]],
    ["roemer", ["Römer", "Tourist Information Römer", "Dom/Römer", "Haus zum Römer"]],
  ])("%s: results categorized as food, shops, car parks, hotels, tickets or tram stops are dropped", (q, want) => {
    expect(parseAutocomplete(amenity(q), "poi").map((s) => s.name)).toEqual(want);
    // The same answer unfiltered still has them (mode `any`, start and end).
    expect(parseAutocomplete(amenity(q)).length).toBeGreaterThanOrEqual(want.length);
  });

  it("isTourPoi: sights, culture, worship, parks and trains stay; addresses and businesses go; no category stays", () => {
    expect(isTourPoi({ result_type: "amenity", category: "entertainment.culture.theatre" })).toBe(true);
    expect(isTourPoi({ result_type: "amenity", category: "tourism.sights.city_hall" })).toBe(true);
    expect(isTourPoi({ result_type: "amenity", category: "public_transport.train" })).toBe(true);
    expect(isTourPoi({ result_type: "amenity" })).toBe(true);
    expect(isTourPoi({ result_type: "amenity", category: "parking.cars" })).toBe(false);
    expect(isTourPoi({ result_type: "amenity", category: "commercial.health_and_beauty.pharmacy;healthcare.pharmacy" })).toBe(false);
    expect(isTourPoi({ result_type: "amenity", category: "public_transport.tram" })).toBe(false);
    expect(isTourPoi({ result_type: "amenity", category: "tourism.information.office" })).toBe(false);
    expect(isTourPoi({ result_type: "street" })).toBe(false);
    expect(isTourPoi({ result_type: "building" })).toBe(false);
    expect(isTourPoi({ result_type: "amenity", category: "tourismus" })).toBe(false);
  });
});
