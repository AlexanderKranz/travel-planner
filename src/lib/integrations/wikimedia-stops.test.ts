import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { chunk, parseCommonsThumbs, parseExtracts, parseLabels, parseStopEntities, yearOf } from "./wikimedia-stops";

const claim = (value: unknown, rank = "normal") => ({ rank, mainsnak: { snaktype: "value", datavalue: { value } } });

describe("Wikidata entities", () => {
  it("sitelinks, preferred image, year (precision ≥ 9), at most two architects, heritage, website", () => {
    const m = parseStopEntities({
      entities: {
        Q1: {
          sitelinks: { dewiki: { title: "Stephansdom" }, enwiki: { title: "St. Stephen's Cathedral" } },
          claims: {
            P18: [claim("Old.jpg"), claim("Best.jpg", "preferred"), claim("Bad.jpg", "deprecated")],
            P571: [claim({ time: "+1147-00-00T00:00:00Z", precision: 9 })],
            P84: [claim({ id: "Q2" }), claim({ id: "Q3" }), claim({ id: "Q4" })],
            P1435: [claim({ id: "Q5" })],
            P856: [claim("https://example.org")],
          },
        },
        Q9: { missing: "" },
      },
    });
    expect(m.get("Q1")).toEqual({
      sitelinks: { de: "Stephansdom", en: "St. Stephen's Cathedral" },
      image: "Best.jpg",
      year: 1147,
      architects: ["Q2", "Q3"],
      heritage: "Q5",
      website: "https://example.org",
    });
    expect(m.has("Q9")).toBe(false);
    expect(() => parseStopEntities({ error: { code: "too-many-ids" } })).toThrow();
  });

  it("year needs year precision", () => {
    expect(yearOf({ time: "+1891-05-01T00:00:00Z", precision: 11 })).toBe(1891);
    expect(yearOf({ time: "+1800-00-00T00:00:00Z", precision: 7 })).toBeNull();
    expect(yearOf("1891")).toBeNull();
  });

  it("labels in de and en", () => {
    expect(parseLabels({ entities: { Q2: { labels: { de: { value: "Anton Pilgram" } } } } }).get("Q2")).toEqual({ de: "Anton Pilgram", en: undefined });
  });

  it("chunks to the API limit", () => {
    expect(chunk([...Array(51).keys()], 50).map((c) => c.length)).toEqual([50, 1]);
  });
});

describe("Wikipedia extracts", () => {
  it("follows normalisation and redirects, keyed by the requested title; disambiguation and missing pages dropped", () => {
    const m = parseExtracts(
      {
        query: {
          normalized: [{ from: "passauer Dom", to: "Passauer Dom" }],
          redirects: [{ from: "Passauer Dom", to: "Dom St. Stephan (Passau)" }],
          pages: [
            { title: "Dom St. Stephan (Passau)", extract: "Der Dom ..." },
            { title: "Hofburg", extract: "x", pageprops: { disambiguation: "" } },
            { title: "Nix", missing: true },
          ],
        },
      },
      ["passauer Dom", "Hofburg", "Nix"],
    );
    expect([...m]).toEqual([["passauer Dom", { title: "Dom St. Stephan (Passau)", text: "Der Dom ..." }]]);
  });
});

describe("Commons thumbnails", () => {
  it("keyed by the Wikidata file name, 330 px thumb with licence metadata", () => {
    const m = parseCommonsThumbs(
      {
        query: {
          normalized: [{ from: "File:dom_1.jpg", to: "File:Dom 1.jpg" }],
          pages: [
            {
              title: "File:Dom 1.jpg",
              imageinfo: [
                {
                  thumburl: "https://upload.wikimedia.org/x/330px-Dom_1.jpg",
                  thumbwidth: 330,
                  thumbheight: 248,
                  mime: "image/jpeg",
                  descriptionurl: "https://commons.wikimedia.org/wiki/File:Dom_1.jpg",
                  extmetadata: { LicenseShortName: { value: "CC0" }, Artist: { value: "<b>A</b>" } },
                },
              ],
            },
          ],
        },
      },
      ["Dom 1.jpg"],
    );
    expect(m.get("Dom 1.jpg")).toMatchObject({ width: 330, height: 248, licenseShortName: "CC0", artistHtml: "<b>A</b>", licenseUrl: null });
  });
});
