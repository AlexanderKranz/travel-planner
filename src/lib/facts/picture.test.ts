import { describe, expect, it } from "vitest";
import {
  artistToText,
  choosePicture,
  classifyLicense,
  commonsTitle,
  displayUrl,
  looksLikeNonPhoto,
  pictureFromFile,
  type CommonsFile,
} from "./picture";

const file = (over: Partial<CommonsFile> = {}): CommonsFile => ({
  title: "File:Passau Altstadt Panorama 5.jpg",
  mime: "image/jpeg",
  width: 3000,
  height: 1500,
  url: "https://upload.wikimedia.org/wikipedia/commons/b/b2/Passau_Altstadt_Panorama_5.jpg",
  descriptionUrl: "https://commons.wikimedia.org/wiki/File:Passau_Altstadt_Panorama_5.jpg",
  licenseShortName: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  artistHtml: '<a href="//commons.wikimedia.org/wiki/User:X">Max Muster</a>',
  ...over,
});

describe("artistToText", () => {
  it("strips markup, decodes entities, collapses whitespace", () => {
    expect(artistToText('<a href="x" onclick="evil()">Max  &amp; Moritz</a><br/>\n<b>Foto</b>')).toBe("Max & Moritz Foto");
  });
  it("never passes markup on, even from encoded entities", () => {
    const t = artistToText("&lt;script&gt;alert(1)&lt;/script&gt;Anna");
    expect(t).not.toMatch(/[<>]/);
    expect(artistToText("<script>alert(1)</script>Anna")).toBe("Anna");
    expect(artistToText("<style>p{}</style><span>Bo</span>")).toBe("Bo");
  });
  it("caps the length and treats unknown as missing", () => {
    expect(artistToText("x".repeat(500))!.length).toBe(120);
    expect(artistToText("Unknown")).toBeNull();
    expect(artistToText("  <br> ")).toBeNull();
    expect(artistToText(null)).toBeNull();
  });
});

describe("artistToText, nested tags", () => {
  it("leaves no tag when removing one would form another", () => {
    expect(artistToText("<scr<b>ipt>Anna")).not.toMatch(/[<>]/);
    expect(artistToText("a<<b>script>b")).not.toMatch(/[<>]/);
  });
});

describe("classifyLicense", () => {
  it.each(["CC0", "CC0 1.0", "Public domain", "PD-old-70", "CC BY 4.0", "CC BY-SA 3.0", "CC BY-SA 2.5", "CC BY-SA 3.0 de", "CC BY 2.0"])(
    "allows %s",
    (n) => expect(classifyLicense(n, null)).not.toBeNull(),
  );
  it.each(["CC0-NC", "CC BY-NC 4.0", "CC BY-ND 2.0", "CC BY-NC-SA 3.0", "GFDL", "Fair use", "", "All rights reserved", "CC BY-SA"])(
    "rejects %s",
    (n) => expect(classifyLicense(n, null)).toBeNull(),
  );
  it("derives the licence url and only accepts creativecommons.org urls (https upgrade)", () => {
    expect(classifyLicense("CC BY-SA 4.0", null)?.url).toBe("https://creativecommons.org/licenses/by-sa/4.0/");
    expect(classifyLicense("CC BY 3.0", "http://evil.example/x")?.url).toBe("https://creativecommons.org/licenses/by/3.0/");
    expect(classifyLicense("CC0", "http://creativecommons.org/publicdomain/zero/1.0/deed.en")?.url).toBe(
      "https://creativecommons.org/publicdomain/zero/1.0/deed.en",
    );
  });
});

describe("looksLikeNonPhoto", () => {
  it.each([
    "File:Passau Karte.png",
    "File:Marbella locator map.jpg",
    "File:Flag of Spain.png",
    "File:Wappen Passau.png",
    "File:Coat of arms of Sylt.jpg",
    "File:Coatofarms_x.jpg",
    "File:Mallorca satellite image.jpg",
    "File:Reykjavik_(Landsat).jpg",
    "File:Stadtplan Passau.jpg",
  ])("rejects %s", (n) => expect(looksLikeNonPhoto(n)).toBe(true));
  it.each(["File:Passau Altstadt Panorama 5.jpg", "File:Akiba denkigai.jpg", "File:Lisboa December 2011-2.jpg"])(
    "keeps %s",
    (n) => expect(looksLikeNonPhoto(n)).toBe(false),
  );
});

describe("displayUrl", () => {
  it("uses the 1920 px thumbnail for big files (1600 px answers HTTP 400)", () => {
    const u = displayUrl("https://upload.wikimedia.org/wikipedia/commons/b/b2/Passau-banner-s1.jpg?utm_source=x", 4503, 645);
    expect(u).toEqual({
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Passau-banner-s1.jpg/1920px-Passau-banner-s1.jpg",
      width: 1920,
      height: 275,
    });
  });
  it("keeps the original (without query) when it is not wider than 1920", () => {
    expect(displayUrl("https://upload.wikimedia.org/wikipedia/commons/a/ab/X.png?x=1", 1500, 900)).toEqual({
      url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/X.png",
      width: 1500,
      height: 900,
    });
  });
  it("rejects other hosts, http and odd paths", () => {
    expect(displayUrl("https://evil.example/wikipedia/commons/a/ab/X.png", 2000, 1000)).toBeNull();
    expect(displayUrl("http://upload.wikimedia.org/wikipedia/commons/a/ab/X.png", 2000, 1000)).toBeNull();
    expect(displayUrl("https://upload.wikimedia.org/wikipedia/commons/X.png", 2000, 1000)).toBeNull();
    expect(displayUrl("not a url", 2000, 1000)).toBeNull();
  });
});

describe("pictureFromFile", () => {
  it("builds a validated image with plain-text author", () => {
    expect(pictureFromFile(file(), "image")).toEqual({
      url: "https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Passau_Altstadt_Panorama_5.jpg/1920px-Passau_Altstadt_Panorama_5.jpg",
      width: 1920,
      height: 960,
      author: "Max Muster",
      licenseName: "CC BY-SA 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      sourcePageUrl: "https://commons.wikimedia.org/wiki/File:Passau_Altstadt_Panorama_5.jpg",
      kind: "image",
      title: "Passau Altstadt Panorama 5.jpg",
    });
  });
  it("rejects svg, gif, small, portrait and non-photo images", () => {
    expect(pictureFromFile(file({ mime: "image/svg+xml", title: "File:X.svg" }), "image")).toBeNull();
    expect(pictureFromFile(file({ mime: "image/gif", title: "File:X.gif" }), "image")).toBeNull();
    expect(pictureFromFile(file({ width: 1000, height: 600 }), "image")).toBeNull();
    expect(pictureFromFile(file({ width: 1500, height: 2000 }), "image")).toBeNull();
    expect(pictureFromFile(file({ title: "File:Marbella locator map.jpg" }), "image")).toBeNull();
  });
  it("banners are kept unless unusable: no filename filter, but must be wide and big enough", () => {
    const banner = file({ title: "File:Plan banner.jpg", width: 4503, height: 645 });
    expect(pictureFromFile(banner, "banner")?.kind).toBe("banner");
    expect(pictureFromFile(file({ width: 500, height: 70 }), "banner")).toBeNull();
    expect(pictureFromFile(file({ width: 2000, height: 1500 }), "banner")).toBeNull();
  });
  it("applies the licence allow-list and requires an author for attribution licences", () => {
    expect(pictureFromFile(file({ licenseShortName: "CC BY-NC 4.0" }), "image")).toBeNull();
    expect(pictureFromFile(file({ artistHtml: null }), "image")).toBeNull();
    expect(pictureFromFile(file({ artistHtml: "<br>" }), "image")).toBeNull();
    const cc0 = pictureFromFile(file({ licenseShortName: "CC0", licenseUrl: null, artistHtml: null }), "image");
    expect(cc0?.author).toBeNull();
    expect(cc0?.licenseUrl).toBe("https://creativecommons.org/publicdomain/zero/1.0/");
    const pd = pictureFromFile(file({ licenseShortName: "Public domain", licenseUrl: null, artistHtml: null }), "image");
    expect(pd).toMatchObject({ author: null, licenseUrl: null });
  });
  it("rejects a description page outside commons.wikimedia.org", () => {
    expect(pictureFromFile(file({ descriptionUrl: "https://evil.example/wiki/File:X.jpg" }), "image")).toBeNull();
  });
});

describe("choosePicture", () => {
  const files = new Map<string, CommonsFile>([
    [commonsTitle("Banner_ok.jpg"), file({ title: "File:Banner ok.jpg", width: 4000, height: 500, url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Banner_ok.jpg" })],
    [commonsTitle("Img.jpg"), file({ title: "File:Img.jpg" })],
    [commonsTitle("nc.jpg"), file({ title: "File:Nc.jpg", licenseShortName: "CC BY-NC 4.0" })],
  ]);
  it("prefers a usable banner over the main image", () => {
    expect(choosePicture(files, ["Banner_ok.jpg"], ["Img.jpg"])?.kind).toBe("banner");
  });
  it("falls back to the image when the banner is unusable, and to null when nothing is", () => {
    expect(choosePicture(files, ["nc.jpg"], ["Img.jpg"])?.kind).toBe("image");
    expect(choosePicture(files, ["nc.jpg", "missing.jpg"], [])).toBeNull();
  });
});
