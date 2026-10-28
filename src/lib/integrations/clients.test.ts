import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/api-cache", () => ({ cached: vi.fn(), cacheKey: vi.fn() }));

import { parseArchive } from "./open-meteo-archive";
import { parsePlaceResponse, parseSearchResponse } from "./open-meteo-geocoding";
import { parseElements } from "./overpass";
import { clipParagraphs, parseSummary } from "./wikivoyage";
import { getCountry, countryDataInfo, listCountries } from "./countries";
import { userAgent } from "./http";

const fx = (p: string) => JSON.parse(readFileSync(join(__dirname, "__fixtures__", p), "utf8"));

describe("open-meteo geocoding", () => {
  it("normalizes Passau search (de)", () => {
    const r = parseSearchResponse(fx("open-meteo/geocoding-search-passau-de.json"));
    expect(r[0]).toEqual({
      geoId: 2855328, name: "Passau", featureCode: "PPLA3", countryCode: "DE", admin1: "Bayern",
      lat: 48.5665, lon: 13.43122, timezone: "Europe/Berlin", population: 50560, suggestedKind: "city",
    });
    expect(r.length).toBeLessThanOrEqual(8);
  });
  it("Marbella (en) and empty result", () => {
    expect(parseSearchResponse(fx("open-meteo/geocoding-search-marbella-en.json"))[0]).toMatchObject({
      geoId: 2514169, countryCode: "ES", timezone: "Europe/Madrid", admin1: "Andalusia",
    });
    expect(parseSearchResponse(fx("open-meteo/geocoding-search-empty.json"))).toEqual([]);
  });
  it("by id, and region kind for non-PPL", () => {
    expect(parsePlaceResponse(fx("open-meteo/geocoding-get-2855328.json")).geoId).toBe(2855328);
    expect(parsePlaceResponse({ id: 1, name: "Andalusia", latitude: 1, longitude: 2, feature_code: "ADM1" }).suggestedKind).toBe("region");
  });
  it("rejects malformed responses", () => {
    expect(() => parseSearchResponse({ results: [{ id: "x" }] })).toThrow();
    expect(() => parsePlaceResponse(fx("open-meteo/geocoding-get-notfound.json"))).toThrow();
  });
});

describe("open-meteo archive", () => {
  it("parses 10 years of daily data", () => {
    const s = parseArchive(fx("open-meteo/archive-malaga-2016-2025.json"));
    expect(s.time).toHaveLength(3653);
    expect(s.time[0]).toBe("2016-01-01");
  });
  it("rejects malformed and mismatched arrays", () => {
    expect(() => parseArchive({})).toThrow();
    expect(() => parseArchive({ daily: { time: ["2020-01-01"], temperature_2m_max: [], temperature_2m_min: [1], precipitation_sum: [1], sunshine_duration: [1] } })).toThrow();
  });
});

describe("overpass", () => {
  it("parses nodes, ways with center, relations", () => {
    const e = parseElements(fx("overpass/golf-marbella-40km.json"));
    expect(e.length).toBe(63);
    expect(e.every((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon))).toBe(true);
  });
  it("empty xmas result is an empty list, not an error", () => {
    expect(parseElements(fx("overpass/xmas-passau.json"))).toEqual([]);
  });
  it("treats an HTTP 200 with a runtime-error remark as failure", () => {
    expect(() => parseElements({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.' })).toThrow(/Overpass/);
  });
  it("rejects non-JSON-shaped bodies", () => {
    expect(() => parseElements("<html>")).toThrow();
  });
});

describe("wikivoyage", () => {
  const anchor = { lat: 48.5665, lon: 13.43122, placeName: "Passau" };
  it("picks the page whose title matches, not the river Inn", () => {
    const s = parseSummary(fx("wikivoyage/geosearch-passau-de.json"), anchor, "de");
    expect(s).toMatchObject({ title: "Passau", url: "https://de.wikivoyage.org/wiki/Passau", lang: "de" });
    expect(s?.extract.length).toBeLessThanOrEqual(900);
    expect(s?.paragraphs).toEqual([s?.extract]);
  });
  it("falls back to the nearest page within 5 km, else null", () => {
    const body = fx("wikivoyage/geosearch-passau-de.json");
    expect(parseSummary(body, { ...anchor, placeName: "Zzz" }, "de")?.title).toBe("Passau"); // 2.6 km
    expect(parseSummary(body, { lat: 48.62, lon: 13.43, placeName: "Zzz" }, "de")).toBeNull();
    expect(parseSummary(fx("wikivoyage/geosearch-none.json"), anchor, "de")).toBeNull();
  });
  it("clips at a sentence boundary within 900 chars and keeps paragraph breaks", () => {
    const sentence = "Dies ist ein Satz, der etwa so lang ist wie ein typischer Satz im Reisefuehrer. ";
    const para = sentence.repeat(4).trim(); // ~320 chars
    const out = clipParagraphs([para, para, para, para].join("\n"));
    expect(out.join("\n\n").length).toBeLessThanOrEqual(900);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.every((p) => p.endsWith("."))).toBe(true);
  });
  it("cuts one very long paragraph at the last sentence end", () => {
    const long = "Erster Satz hier. ".repeat(100).trim();
    const out = clipParagraphs(long);
    expect(out).toHaveLength(1);
    expect(out[0].length).toBeLessThanOrEqual(900);
    expect(out[0].endsWith("Satz hier.")).toBe(true);
  });
  it("uses a short intro as is and falls back to a word cut with an ellipsis", () => {
    expect(clipParagraphs("Marbella ist ein Ort.")).toEqual(["Marbella ist ein Ort."]);
    const noStops = "wort ".repeat(400).trim();
    const out = clipParagraphs(noStops);
    expect(out[0].endsWith("…")).toBe(true);
    expect(out[0].length).toBeLessThanOrEqual(901);
  });
  it("busy error body 200 is a failure", () => {
    expect(() => parseSummary(fx("wikivoyage/error-busy.json"), anchor, "de")).toThrow(/Wikivoyage/);
  });
});

describe("countries and http", () => {
  it("looks up countries", () => {
    expect(getCountry("es")).toMatchObject({ nameEn: "Spain", callingCodes: ["+34"], drivingSide: "right" });
    expect(getCountry("GB")?.drivingSide).toBe("left");
    expect(getCountry("XX")).toBeUndefined();
    expect(countryDataInfo.count).toBeGreaterThan(240);
    expect(listCountries()[0].nameEn.length).toBeGreaterThan(0);
  });
  it("builds a descriptive user agent", () => {
    expect(userAgent({ INTEGRATIONS_CONTACT: "a@b.de", APP_URL: "https://x.app" })).toBe("TravelPlanner/1.0 (+https://x.app; a@b.de)");
  });
});
