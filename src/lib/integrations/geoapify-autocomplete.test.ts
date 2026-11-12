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

  it("skips malformed results instead of repairing them; a body without results is a shape error", () => {
    const body = { results: [{ name: "x", lat: 1, lon: 2 }, { place_id: "abcdef0123", lat: 99, lon: 2, name: "bad lat" }, { place_id: "abcdef0123", lat: 1, lon: 2 }] };
    expect(parseAutocomplete(body)).toEqual([]);
    expect(() => parseAutocomplete({ features: [] })).toThrow();
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
