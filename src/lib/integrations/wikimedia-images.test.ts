import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { parseCommonsClaims, parseCommonsFiles } = await import("./wikimedia-images");
const { parseWikibaseItem } = await import("./wikipedia");
const { choosePicture } = await import("@/lib/facts/picture");

const fx = (n: string) => JSON.parse(readFileSync(join(__dirname, "__fixtures__", "wikimedia", n), "utf8"));
const passau = { lat: 48.5665, lon: 13.4312 };

describe("parseWikibaseItem", () => {
  it("returns the item of a nearby article", () => {
    expect(parseWikibaseItem(fx("wikibase-item-passau-de.json"), passau)).toBe("Q4190");
  });
  it("rejects disambiguation pages, far-away pages and missing pages", () => {
    expect(parseWikibaseItem(fx("wikibase-item-disambiguation-en.json"), passau)).toBeNull();
    expect(parseWikibaseItem(fx("wikibase-item-passau-de.json"), { lat: 35.68, lon: 139.69 })).toBeNull();
    expect(parseWikibaseItem({ query: { pages: [{ title: "X", missing: true }] } }, passau)).toBeNull();
  });
  it("throws on an API error payload", () => {
    expect(() => parseWikibaseItem({ error: { code: "internal_api_error" } }, passau)).toThrow();
  });
});

describe("parseCommonsClaims", () => {
  it("reads banner and image file names", () => {
    expect(parseCommonsClaims(fx("claims-p948-passau.json"), "P948")).toEqual(["Passau-banner-s1.jpg"]);
    expect(parseCommonsClaims(fx("claims-p18-passau.json"), "P18")).toContain("Passau Altstadt Panorama 5.jpg");
    expect(parseCommonsClaims(fx("claims-none.json"), "P948")).toEqual([]);
  });
  it("puts preferred rank first and drops deprecated and novalue claims", () => {
    const c = (v: string | null, rank: string, snaktype = "value") => ({
      rank,
      mainsnak: { snaktype, ...(v ? { datavalue: { value: v, type: "string" } } : {}) },
    });
    const body = {
      claims: { P18: [c("a.jpg", "normal"), c("b.jpg", "preferred"), c("c.jpg", "deprecated"), c(null, "normal", "novalue"), c("a|b.jpg", "normal")] },
    };
    expect(parseCommonsClaims(body, "P18")).toEqual(["b.jpg", "a.jpg"]);
  });
});

describe("Commons file metadata (recorded response) to picture", () => {
  const files = parseCommonsFiles(fx("commons-files.json"));
  it("skips missing files and keeps the rest keyed by Commons title", () => {
    expect([...files.keys()].sort()).toEqual(["File:Akiba denkigai.jpg", "File:Passau-banner-s1.jpg"]);
  });
  it("Passau banner: CC BY-SA 3.0, plain-text author, 1920 px thumbnail on upload.wikimedia.org", () => {
    expect(choosePicture(files, ["Passau-banner-s1.jpg"], [])).toEqual({
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Passau-banner-s1.jpg/1920px-Passau-banner-s1.jpg",
      width: 1920,
      height: 275,
      author: "Traveler100",
      licenseName: "CC BY-SA 3.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/3.0",
      sourcePageUrl: "https://commons.wikimedia.org/wiki/File:Passau-banner-s1.jpg",
      kind: "banner",
      title: "Passau-banner-s1.jpg",
    });
  });
  it("CC0 image; http licence url becomes https", () => {
    expect(choosePicture(files, [], ["Akiba_denkigai.jpg"])).toMatchObject({
      kind: "image",
      licenseName: "CC0",
      licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/deed.en",
      author: "Jmho",
    });
  });
  it("throws on an error payload", () => {
    expect(() => parseCommonsFiles({ error: { code: "x" } })).toThrow();
  });
});
