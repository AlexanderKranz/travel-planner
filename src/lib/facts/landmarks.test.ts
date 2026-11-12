import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { parseElements, type RawOsmElement } from "@/lib/integrations/overpass";
import {
  classify,
  collectLandmarks,
  foldName,
  LANDMARK_FILTERS,
  matchLandmarks,
  matchTier,
  rankLandmarks,
  sameAsLandmark,
  type Landmark,
} from "./landmarks";

/**
 * Fixtures recorded 2026-11-12 (issue #172): Overpass with the landmark filters around the GeoNames points of
 * Frankfurt, Wien and Passau (trimmed: the best-known ids plus noise the code must drop), and the sitelink counts of
 * those ids from Wikidata (Query Service `wikibase:sitelinks`, equal to the Action API pageprops for the 50 checked).
 */
const fx = (p: string) => JSON.parse(readFileSync(join(__dirname, "../integrations/__fixtures__", p), "utf8"));
const CITY = {
  frankfurt: { lat: 50.11552, lon: 8.68417 },
  wien: { lat: 48.20849, lon: 16.37208 },
  passau: { lat: 48.5665, lon: 13.43122 },
} as const;
function ranked(city: keyof typeof CITY, withSitelinks = true): Landmark[] {
  const els = parseElements(fx(`overpass/landmarks-${city}-8km.json`));
  return rankLandmarks(collectLandmarks(els, CITY[city]), withSitelinks ? fx(`wikidata/sitelinks-${city}.json`) : null);
}
const names = (l: readonly Landmark[]) => l.map((x) => x.name);

describe("landmark set (Frankfurt, Wien, Passau fixtures)", () => {
  it("Frankfurt: the major landmarks are at the top, in prominence order", () => {
    const top = names(ranked("frankfurt").slice(0, 15));
    for (const n of [
      "Kaiserdom St. Bartholomäus",
      "Römer",
      "Alte Oper",
      "Paulskirche",
      "Frankfurt (Main) Hauptbahnhof",
      "Main Tower",
      "Städel Museum",
      "Goethe-Haus",
    ]) {
      expect(top).toContain(n);
    }
    expect(top.slice(0, 5)).toEqual([
      "Frankfurter Wertpapierbörse",
      "Paulskirche",
      "Kaiserdom St. Bartholomäus",
      "Städel Museum",
      "Römer",
    ]);
    // Eiserner Steg is in the set (search finds it), only further down.
    expect(names(ranked("frankfurt"))).toContain("Eiserner Steg");
  });

  it("Frankfurt: U-Bahn stations, and office towers or companies without landmark=yes, are not landmarks", () => {
    const all = ranked("frankfurt");
    expect(all.filter((l) => l.cat === "station").map((l) => l.name)).not.toContain("Dom/Römer");
    expect(names(all)).not.toContain("Commerzbank Tower");
    expect(names(all)).not.toContain("AECOM Deutschland GmbH");
    expect(names(all)).toContain("Messeturm"); // landmark=yes in OSM
    // The mainline station stays, as the station (not the shops inside it).
    expect(all.find((l) => l.wikidata === "Q165368")).toMatchObject({ name: "Frankfurt (Main) Hauptbahnhof", kind: "station", cat: "station" });
  });

  it("Wien and Passau: the main sights lead", () => {
    expect(names(ranked("wien").slice(0, 5))).toEqual([
      "Stephansdom",
      "Hofburg",
      "Wiener Staatsoper",
      "Belvedere",
      "Kunsthistorisches Museum",
    ]);
    expect(names(ranked("wien").slice(0, 15))).toContain("Schloss Schönbrunn");
    expect(names(ranked("passau").slice(0, 3))).toEqual(["Dom St. Stephan", "Passau Hbf", "Veste Oberhaus"]);
  });

  it("one element per wikidata id: the castle over a gate or park with the same id (Hofburg, Schönbrunn)", () => {
    const wien = ranked("wien");
    expect(wien.filter((l) => l.wikidata === "Q46242").map((l) => l.name)).toEqual(["Hofburg"]);
    expect(wien.filter((l) => l.wikidata === "Q131330").map((l) => l.name)).toEqual(["Schloss Schönbrunn"]);
    expect(new Set(wien.map((l) => l.wikidata)).size).toBe(wien.length);
  });

  it("same name within 150 m is one place; a station's levels and stops do not enter the set", () => {
    const base = { type: "node" as const, lat: 50.1, lon: 8.6 };
    const els: RawOsmElement[] = [
      { ...base, id: 1, tags: { name: "St. Peter", amenity: "place_of_worship", wikidata: "Q1", wikipedia: "de:x" } },
      { ...base, id: 2, lat: 50.1005, tags: { name: "St. Peter", historic: "church", wikidata: "Q2" } },
      { ...base, id: 3, lat: 50.11, tags: { name: "St. Peter", amenity: "place_of_worship", wikidata: "Q3" } },
      { ...base, id: 4, tags: { name: "Hauptbahnhof", railway: "station", station: "subway", wikidata: "Q4" } },
      { ...base, id: 5, tags: { name: "Hauptbahnhof", railway: "platform", wikidata: "Q5" } },
      { ...base, id: 6, tags: { name: "Hauptbahnhof", public_transport: "stop_position", wikidata: "Q6" } },
      { ...base, id: 7, tags: { name: "Kein Wikidata", amenity: "theatre" } },
    ];
    const out = collectLandmarks(els, { lat: 50.1, lon: 8.6 });
    expect(out.map((l) => l.osmId).sort()).toEqual([1, 3]);
  });

  it("the exact radius applies (the Overpass bbox reaches further)", () => {
    const el = { type: "node" as const, id: 1, lat: 50.2, lon: 8.6, tags: { name: "Fern", tourism: "museum", wikidata: "Q1" } };
    expect(collectLandmarks([el], { lat: 50.1, lon: 8.6 })).toEqual([]);
    expect(collectLandmarks([el], { lat: 50.1, lon: 8.6 }, 12)).toHaveLength(1);
  });

  it("without sitelinks the fallback order still keeps the main sights in the top 25", () => {
    const top = names(ranked("frankfurt", false).slice(0, 25));
    for (const n of ["Kaiserdom St. Bartholomäus", "Römer", "Alte Oper", "Paulskirche", "Städel Museum"]) expect(top).toContain(n);
  });

  it("every filter line needs a wikidata id", () => {
    for (const f of LANDMARK_FILTERS) expect(f).toContain('["wikidata"]');
  });
});

describe("classify", () => {
  it("names the place by its most specific tag", () => {
    expect(classify({ amenity: "place_of_worship", building: "cathedral", tourism: "attraction" })).toEqual({ kind: "sight", cat: "place_of_worship" });
    expect(classify({ amenity: "townhall", tourism: "attraction" })).toEqual({ kind: "sight", cat: "townhall" });
    expect(classify({ railway: "station" })).toEqual({ kind: "station", cat: "station" });
    expect(classify({ highway: "pedestrian", bridge: "yes" })).toEqual({ kind: "sight", cat: "bridge" });
    expect(classify({ highway: "pedestrian" })).toEqual({ kind: "street", cat: "pedestrian" });
    expect(classify({ historic: "memorial" })).toEqual({ kind: "memorial", cat: "memorial" });
    expect(classify({ building: "commercial", landmark: "yes" })).toEqual({ kind: "building", cat: "commercial" });
  });
});

describe("matching a query against the landmark set", () => {
  const ffm = ranked("frankfurt");
  const first = (q: string, set = ffm) => matchLandmarks(set, q, 3).map((l) => l.name);

  it.each([
    ["Dom", "Kaiserdom St. Bartholomäus"],
    ["dom", "Kaiserdom St. Bartholomäus"],
    ["Kaiserdom", "Kaiserdom St. Bartholomäus"],
    ["Alte Oper", "Alte Oper"],
    ["alte  oper", "Alte Oper"],
    ["Hauptbahnhof", "Frankfurt (Main) Hauptbahnhof"],
    ["Römer", "Römer"],
    ["romer", "Römer"],
    ["Städel", "Städel Museum"],
    ["eiserner", "Eiserner Steg"],
  ])("Frankfurt %s → %s first", (q, want) => {
    expect(first(q)[0]).toBe(want);
  });

  it("Wien: Dom → Stephansdom (inside the word), Oper → Staatsoper first by prominence", () => {
    const wien = ranked("wien");
    expect(first("Dom", wien)[0]).toBe("Stephansdom");
    expect(first("Oper", wien)[0]).toBe("Wiener Staatsoper");
  });

  it("tiers: equal name, then word start, then inside a word", () => {
    const l = ffm.find((x) => x.wikidata === "Q57341")!;
    expect(matchTier(l, "Dom")).toBe(0); // loc_name
    expect(matchTier(l, "Kaiser")).toBe(1);
    expect(matchTier(l, "bartholo")).toBe(1);
    expect(matchTier(l, "serdo")).toBe(2);
    expect(matchTier(l, "Paris")).toBeNull();
  });

  it("folds case, accents, ß and spacing", () => {
    expect(foldName("  Straße  am  Römer ")).toBe("strasse am romer");
  });

  it("a Geoapify stop or level at a matched landmark is that landmark", () => {
    const hbf = ffm.find((l) => l.wikidata === "Q165368")!;
    const dom = ffm.find((l) => l.wikidata === "Q57341")!;
    const roemer = ffm.find((l) => l.wikidata === "Q195146")!;
    expect(sameAsLandmark({ name: "Hauptbahnhof", lat: 50.1077355, lon: 8.6637933 }, hbf)).toBe(true);
    expect(sameAsLandmark({ name: "Dom/Römer", lat: 50.110725, lon: 8.6836678 }, roemer)).toBe(true);
    expect(sameAsLandmark({ name: "Dom/Römer", lat: 50.110725, lon: 8.6836678 }, dom)).toBe(true);
    // Another place of a similar name is not.
    expect(sameAsLandmark({ name: "Dommuseum", lat: dom.lat, lon: dom.lon }, dom)).toBe(false);
    expect(sameAsLandmark({ name: "Haus zum Römer", lat: roemer.lat, lon: roemer.lon, category: "tourism.sights" }, roemer)).toBe(false);
    expect(sameAsLandmark({ name: "Römer", lat: roemer.lat, lon: roemer.lon, category: "tourism.sights.city_hall" }, roemer)).toBe(true);
    expect(sameAsLandmark({ name: "Hauptbahnhof", lat: 50.1077355, lon: 8.6637933, category: "public_transport.subway" }, hbf)).toBe(true);
    expect(sameAsLandmark({ name: "Hauptbahnhof", lat: 50.13, lon: 8.92 }, hbf)).toBe(false);
  });
});
