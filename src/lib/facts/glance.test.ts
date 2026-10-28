import { describe, expect, it } from "vitest";
import type { DaylightDay, MonthlyClimate, WeatherFacts } from "@/lib/domain";
import { climateGlance, flagEmoji, glanceMonths, middleDay, summaryParagraphs } from "./glance";

const month = (m: number, t: number): MonthlyClimate => ({
  month: m, tMaxC: t, tMinC: t - 10, precipMm: 10, wetDays: m, sunshineHours: 6,
});
const weather = (selected: number[]): WeatherFacts => ({
  months: Array.from({ length: 12 }, (_, i) => month(i + 1, 10 + i)),
  selectedMonths: selected,
  period: { from: 2015, to: 2024 },
});

describe("flagEmoji", () => {
  it("maps ISO codes to regional indicators", () => {
    expect(flagEmoji("es")).toBe("🇪🇸");
    expect(flagEmoji("DE")).toBe("🇩🇪");
  });
  it("returns empty for invalid codes", () => {
    expect(flagEmoji("")).toBe("");
    expect(flagEmoji("ESP")).toBe("");
    expect(flagEmoji("1!")).toBe("");
  });
});

describe("glanceMonths", () => {
  it("uses selected months in order", () => {
    expect(glanceMonths(weather([4, 3]), 7).map((m) => m.month)).toEqual([3, 4]);
  });
  it("falls back to the reference month", () => {
    expect(glanceMonths(weather([]), 7).map((m) => m.month)).toEqual([7]);
  });
});

describe("climateGlance", () => {
  it("averages", () => {
    const g = climateGlance([month(3, 18), month(4, 20)])!;
    expect(g.tMaxC).toBe(19);
    expect(g.tMinC).toBe(9);
    expect(g.wetDays).toBe(3.5);
  });
  it("is null for no rows", () => expect(climateGlance([])).toBeNull());
});

describe("middleDay", () => {
  const d = (date: string): DaylightDay => ({ date, sunrise: null, sunset: null, dusk: null, daylightMinutes: 0 });
  it("picks the middle", () => {
    expect(middleDay([d("a"), d("b"), d("c")])?.date).toBe("b");
    expect(middleDay([d("a"), d("b")])?.date).toBe("a");
    expect(middleDay([])).toBeNull();
  });
});

describe("summaryParagraphs", () => {
  const base = { title: "T", url: "u", lang: "de" };
  it("splits the extract on blank lines", () => {
    expect(summaryParagraphs({ ...base, extract: "A\n\nB\n  \nC" })).toEqual(["A", "B", "C"]);
  });
  it("prefers paragraphs", () => {
    expect(summaryParagraphs({ ...base, extract: "x", paragraphs: ["P1", " P2 "] })).toEqual(["P1", "P2"]);
  });
});
