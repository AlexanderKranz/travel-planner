import { describe, expect, it } from "vitest";
import { pdfStopInfo, stopLine } from "./pdf-lines";

describe("stopLine", () => {
  it("takes the first sentence", () => {
    expect(stopLine("Der Stephansdom ist eine Kathedrale. Er steht in Wien.")).toBe("Der Stephansdom ist eine Kathedrale.");
  });
  it("cuts a long first sentence on a word, with … and at most 140 characters", () => {
    // The 139th character falls inside "Donaukanal": the cut goes back to the previous whole word.
    const long = `${"Am Ufer ".repeat(16)}liegt der Donaukanal mit vielen Brücken.`;
    const out = stopLine(long);
    expect(out.length).toBeLessThanOrEqual(140);
    expect(out).toMatch(/ der…$/);
  });
  it("does not end the first sentence at abbreviations or ordinal numbers", () => {
    expect(stopLine("Die St. Peter-Kirche, z. B. im 18. Jh. umgebaut, liegt nahe dem Graben. Sie ist barock.")).toBe(
      "Die St. Peter-Kirche, z. B. im 18. Jh. umgebaut, liegt nahe dem Graben.",
    );
  });
});

describe("pdfStopInfo", () => {
  const info = {
    v: 1 as const,
    locale: "de" as const,
    stops: [
      { key: "osm:n1", status: "ok" as const, checkedAt: "2026-11-10T00:00:00Z", lang: "de" as const, title: "Stephansdom", text: "Eine Kathedrale. Mehr." },
      { key: "osm:n2", status: "ok" as const, checkedAt: "2026-11-08T00:00:00Z", lang: "en" as const, title: "Hofburg Palace", text: "A palace." },
      { key: "osm:n3", status: "none" as const, checkedAt: "2026-11-01T00:00:00Z" },
    ],
  };
  it("lines parallel to the stops, articles with links, English fallback marked, oldest check date", () => {
    const r = pdfStopInfo(info, ["osm:n1", "osm:n3", "osm:n2"]);
    expect(r?.lines).toEqual(["Eine Kathedrale.", null, "A palace."]);
    expect(r?.articles).toEqual([
      { title: "Stephansdom", url: "https://de.wikipedia.org/wiki/Stephansdom", en: false },
      { title: "Hofburg Palace", url: "https://en.wikipedia.org/wiki/Hofburg_Palace", en: true },
    ]);
    expect(r?.checkedAt).toBe("2026-11-08T00:00:00Z");
  });
  it("null without any text", () => {
    expect(pdfStopInfo(info, ["osm:n3"])).toBeNull();
    expect(pdfStopInfo(null, ["osm:n1"])).toBeNull();
  });
});
