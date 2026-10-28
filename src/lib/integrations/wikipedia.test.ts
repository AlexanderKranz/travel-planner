import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { parseWikipediaSummary } = await import("./wikipedia");

const passau = { lat: 48.567, lon: 13.431 };
const page = (over: Record<string, unknown> = {}) => ({
  query: {
    pages: [
      {
        title: "Passau",
        extract: "Passau ist eine kreisfreie Universitätsstadt in Niederbayern.\nSie liegt an Donau, Inn und Ilz.",
        fullurl: "https://de.wikipedia.org/wiki/Passau",
        coordinates: [{ lat: 48.573, lon: 13.457 }],
        ...over,
      },
    ],
  },
});

describe("parseWikipediaSummary", () => {
  it("returns paragraphs for a nearby article", () => {
    const s = parseWikipediaSummary(page(), passau, "de");
    expect(s?.paragraphs).toEqual([
      "Passau ist eine kreisfreie Universitätsstadt in Niederbayern.",
      "Sie liegt an Donau, Inn und Ilz.",
    ]);
    expect(s?.url).toBe("https://de.wikipedia.org/wiki/Passau");
  });

  it("rejects disambiguation pages, missing pages and same-name places far away", () => {
    expect(parseWikipediaSummary(page({ pageprops: { disambiguation: "" } }), passau, "de")).toBeNull();
    expect(parseWikipediaSummary(page({ missing: true, extract: undefined }), passau, "de")).toBeNull();
    expect(parseWikipediaSummary(page({ coordinates: [{ lat: 40, lon: -3 }] }), passau, "de")).toBeNull();
    expect(parseWikipediaSummary(page({ coordinates: undefined }), passau, "de")).toBeNull();
  });

  it("throws on API errors so they are not cached", () => {
    expect(() => parseWikipediaSummary({ error: { code: "maxlag" } }, passau, "de")).toThrow();
  });
});
