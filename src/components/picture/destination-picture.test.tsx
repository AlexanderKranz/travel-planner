import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { classifyLicense, pictureFromFile, type CommonsFile } from "@/lib/facts/picture";
import type { DestinationPictureResult } from "@/lib/domain/picture";
import { DestinationPictureBand } from "./destination-picture";

const pic: DestinationPictureResult = {
  url: "https://upload.wikimedia.org/wikipedia/commons/b/b2/Passau.jpg",
  width: 1920, height: 800, author: "Max <b>Muster</b>", licenseName: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  sourcePageUrl: "https://commons.wikimedia.org/wiki/File:Passau.jpg", kind: "banner", title: "Passau.jpg",
  fetchedAt: "2026-10-31T00:00:00.000Z",
};
const render = (locale: "de" | "en", p: DestinationPictureResult) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "de" ? de : en} timeZone="Europe/Berlin">
      <DestinationPictureBand picture={p} placeName="Passau" />
    </NextIntlClientProvider>,
  );

describe("DestinationPictureBand (QA)", () => {
  it("renders author as escaped text, with licence link, source link and crop note in de and en", () => {
    for (const l of ["de", "en"] as const) {
      const html = render(l, pic);
      expect(html).not.toContain("<b>Muster");
      expect(html).toContain("&lt;b&gt;Muster");
      expect(html).toContain('href="https://creativecommons.org/licenses/by-sa/4.0/"');
      expect(html).toContain('href="https://commons.wikimedia.org/wiki/File:Passau.jpg"');
      expect(html).toContain(l === "de" ? "Bild zugeschnitten." : "Image cropped.");
      expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
    }
  });
  it("public domain without licence url renders plain text, no empty link", () => {
    const html = render("en", { ...pic, author: null, licenseName: "Public domain", licenseUrl: null });
    expect(html).toContain("Public domain");
    expect(html.match(/<a /g)).toHaveLength(1);
  });
});

describe("licence allow-list edge cases (QA)", () => {
  it.each([
    "GFDL", "GFDL 1.2", "CC BY-NC 4.0", "CC BY-NC-SA 3.0", "CC BY-ND 2.0", "CC BY-NC-ND 4.0", "CC-BY-NC-4.0",
    "CC BY-SA 4.0, GFDL", "Attribution", "Copyrighted free use", "Public domain NC", "PDF", "CC BY 4", "Fair use",
    "CC BY-SA", "cc by-nd-sa 4.0", "<script>", "",
  ])("rejects %j", (n) => {
    expect(classifyLicense(n, null)).toBeNull();
  });
  it.each(["CC BY 4.0", "CC BY-SA 3.0", "CC-BY-SA-4.0", "CC BY-SA 2.0 DE", "CC0", "CC0 1.0", "Public domain", "PD-old", "PD"])("accepts %j", (n) => {
    expect(classifyLicense(n, null)).not.toBeNull();
  });
  it("javascript: licence url or description url never survives", () => {
    const f: CommonsFile = {
      title: "File:A.jpg", mime: "image/jpeg", width: 3000, height: 1000,
      url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/A.jpg",
      descriptionUrl: "https://commons.wikimedia.org/wiki/File:A.jpg",
      licenseShortName: "CC BY 4.0", licenseUrl: "javascript:alert(1)", artistHtml: "Anna",
    };
    expect(pictureFromFile(f, "banner")?.licenseUrl).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(pictureFromFile({ ...f, descriptionUrl: "javascript:alert(1)" }, "banner")).toBeNull();
    expect(pictureFromFile({ ...f, url: "https://evil.example/wikipedia/commons/a/ab/A.jpg" }, "banner")).toBeNull();
    expect(pictureFromFile({ ...f, url: "https://upload.wikimedia.org.evil.example/wikipedia/commons/a/ab/A.jpg" }, "banner")).toBeNull();
  });
});
