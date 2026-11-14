import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { TourInput } from "@/lib/domain/tour";
import { buildStopInfo, clipStopText, stopImage, type ThumbPart } from "./build";
import { cleanOpeningHours, cleanWebsite, osmFacts, osmRefOf, parseWikipediaTag, yearKind } from "./match";
import { eligibleStops, storedView } from "./view";

const thumb = (o: Partial<ThumbPart> = {}): ThumbPart => ({
  thumbUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Dom.jpg/330px-Dom.jpg",
  width: 330,
  height: 220,
  mime: "image/jpeg",
  licenseShortName: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0",
  artistHtml: '<a href="x">Jane <b>Doe</b></a>',
  ...o,
});

describe("matching (spec 2)", () => {
  it("only osm: keys get a card", () => {
    expect(osmRefOf("osm:n123")).toEqual({ type: "node", id: 123 });
    expect(osmRefOf("osm:w4")).toEqual({ type: "way", id: 4 });
    expect(osmRefOf("osm:r9")).toEqual({ type: "relation", id: 9 });
    expect(osmRefOf("geo:2761369")).toBeNull();
    expect(osmRefOf("gfy:abc")).toBeNull();
  });

  it("wikipedia tag: de/en with prefix only, decoded, underscores as spaces", () => {
    expect(parseWikipediaTag("de:Passauer_Dom")).toEqual({ lang: "de", title: "Passauer Dom" });
    expect(parseWikipediaTag("en:St.%20Stephen%27s")).toEqual({ lang: "en", title: "St. Stephen's" });
    expect(parseWikipediaTag("fr:Notre-Dame")).toBeNull();
    expect(parseWikipediaTag("Passauer Dom")).toBeNull();
  });

  it("wikidata wins; websites only http(s), bare domains get https, no credentials", () => {
    const f = osmFacts({ wikidata: "Q123", wikipedia: "de:X", website: "www.example.org/x", opening_hours: "Mo-Fr 09:00-17:00" });
    expect(f).toEqual({ qid: "Q123", wikipedia: { lang: "de", title: "X" }, website: "https://www.example.org/x", openingHours: "Mo-Fr 09:00-17:00" });
    expect(osmFacts({ wikidata: "Q12a" }).qid).toBeNull();
    expect(cleanWebsite("javascript:alert(1)")).toBeNull();
    expect(cleanWebsite("ftp://example.org")).toBeNull();
    expect(cleanWebsite("https://user:pw@example.org")).toBeNull();
    expect(cleanWebsite("localhost")).toBeNull();
    expect(osmFacts({ "contact:website": "http://museum.example" }).website).toBe("http://museum.example/");
  });

  it("opening hours over 255 characters are left out, never cut", () => {
    expect(cleanOpeningHours("x".repeat(255))).toHaveLength(255);
    expect(cleanOpeningHours("x".repeat(256))).toBeNull();
  });

  it("year wording by category", () => {
    expect(yearKind("place_of_worship")).toBe("built");
    expect(yearKind("museum")).toBe("opened");
    expect(yearKind("park")).toBe("since");
    expect(yearKind(undefined)).toBe("since");
  });
});

describe("card (spec 3, 4, 12)", () => {
  it("text clipped on a sentence to at most 700 characters, marked clipped", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Satz Nummer ${i} über den Dom.`).join(" ");
    const r = clipStopText(long)!;
    expect(r.text.length).toBeLessThanOrEqual(700);
    expect(r.clipped).toBe(true);
    expect(clipStopText("Kurz.")).toEqual({ text: "Kurz.", clipped: false });
    expect(clipStopText("  ")).toBeNull();
  });

  it("pictures: free raster thumbnails on upload.wikimedia.org; CC BY(-SA) needs an artist, CC0 does not", () => {
    expect(stopImage("Dom.jpg", thumb())).toMatchObject({ licence: "CC BY-SA 4.0", artist: "Jane Doe", w: 330, file: "Dom.jpg" });
    expect(stopImage("Dom.jpg", thumb({ artistHtml: null }))).toBeNull();
    expect(stopImage("Dom.jpg", thumb({ artistHtml: null, licenseShortName: "CC0", licenseUrl: null }))).toMatchObject({ licence: "CC0" });
    expect(stopImage("Dom.jpg", thumb({ licenseShortName: "CC BY-NC 4.0" }))).toBeNull();
    expect(stopImage("Dom.svg", thumb({ mime: "image/svg+xml" }))).toBeNull();
    expect(stopImage("Dom.jpg", thumb({ thumbUrl: "https://evil.example/x.jpg" }))).toBeNull();
    expect(stopImage("Wappen Passau.jpg", thumb())).toBeNull();
  });

  it("builds an ok card with text, facts and picture; OSM website before Wikidata", () => {
    const s = buildStopInfo({
      key: "osm:w1",
      cat: "place_of_worship",
      locale: "de",
      checkedAt: "2026-11-14T00:00:00.000Z",
      qid: "Q1",
      osm: { qid: "Q1", wikipedia: null, website: "https://dom.example/", openingHours: "Mo-Su 06:00-19:00" },
      entity: { sitelinks: { de: "Stephansdom" }, image: "Dom.jpg", year: 1147, architects: ["Q2"], heritage: "Q3", website: "https://wd.example" },
      extract: { lang: "de", part: { title: "Stephansdom", text: "Der Stephansdom ist eine Kirche." } },
      thumb: thumb(),
      labels: new Map([["Q2", { de: "Anton Pilgram" }], ["Q3", { en: "Listed" }]]),
    });
    expect(s).toMatchObject({
      status: "ok",
      qid: "Q1",
      lang: "de",
      title: "Stephansdom",
      text: "Der Stephansdom ist eine Kirche.",
      facts: { year: 1147, yearKind: "built", architects: ["Anton Pilgram"], heritage: "Listed", website: "https://dom.example/", websiteFrom: "osm", openingHours: "Mo-Su 06:00-19:00" },
    });
    expect(s.clipped).toBeUndefined();
  });

  it("nothing usable → status none with key and date only", () => {
    const s = buildStopInfo({ key: "osm:n2", locale: "de", checkedAt: "t", qid: null, osm: null, entity: null, extract: null, thumb: undefined, labels: new Map() });
    expect(s).toEqual({ key: "osm:n2", status: "none", checkedAt: "t" });
  });
});

describe("view (spec 5)", () => {
  const input = TourInput.parse({
    start: { key: "geo:1", name: "Wien", lat: 48.2, lon: 16.37, source: "geonames" },
    places: [
      { key: "osm:w1", name: "Dom", lat: 48.2, lon: 16.37, source: "osm", cat: "place_of_worship" },
      { key: "gfy:x", name: "Hotel", lat: 48.21, lon: 16.36, source: "geoapify" },
      { key: "osm:n2", name: "Prater", lat: 48.21, lon: 16.39, source: "osm" },
    ],
    end: "start",
  });
  const now = Date.parse("2026-11-14T00:00:00Z");

  it("eligible: osm points only, in tour order", () => {
    expect(eligibleStops(input)).toEqual([{ key: "osm:w1", cat: "place_of_worship" }, { key: "osm:n2" }]);
  });

  it("fresh entries in the owner's locale count; stale, missing or other-locale entries are pending", () => {
    const stored = { v: 1, locale: "de", stops: [{ key: "osm:w1", status: "none", checkedAt: "2026-11-01T00:00:00Z" }, { key: "osm:n2", status: "none", checkedAt: "2026-09-01T00:00:00Z" }] };
    expect(storedView(stored, eligibleStops(input), "de", now)).toEqual({ stops: [stored.stops[0]], pending: ["osm:n2"] });
    expect(storedView(stored, eligibleStops(input), "en", now).pending).toEqual(["osm:w1", "osm:n2"]);
    expect(storedView(null, eligibleStops(input), "de", now).pending).toEqual(["osm:w1", "osm:n2"]);
  });
});
