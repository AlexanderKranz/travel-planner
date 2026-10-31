import { describe, expect, it } from "vitest";
import { cleanReason, REASON_BANNED } from "./reason";

describe("REASON_BANNED / cleanReason (E6)", () => {
  const banned = [
    "Nur 2 h Flug von Frankfurt",
    "Hotels ab 49 € pro Nacht",
    "30 km vom Strand entfernt",
    "Direktflug ab Frankfurt",
    "Täglich geöffnet, Öffnungszeiten prüfen",
    "Short flight from Frankfurt",
    "Only 2.5 hours away",
    "Around $120 a night",
    "Mit der Airline in zwei Stunden da",
    "Die Flugzeit ist kurz",
    "open daily from 9",
    "Ein nonstop Erlebnis",
    "Man kann dorthin fliegen",
    "Fly there in no time",
    "about 12 miles of coast",
    "18 Min vom Zentrum",
  ];
  for (const text of banned) {
    it(`removes the reason, keeps the card: ${text}`, () => {
      expect(cleanReason(text)).toEqual({ reason: null, removed: true });
    });
  }

  const fine = [
    "Schöne Ausflüge in die Umgebung",
    "Viele Ausflugsziele für Kinder",
    "Flache Golfplätze und mildes Klima im März",
    "Weihnachtsmärkte und Familienprogramm in der Altstadt",
    "Ruhige Strände, ideal für Kleinkinder",
    "Perfect for a relaxed golf week with a friend",
    "Mittelalterliche Altstadt mit Fluss und Cafés", // "Fluss" / "Flug" is not a substring of Fluss
  ];
  for (const text of fine) {
    it(`keeps: ${text}`, () => {
      expect(cleanReason(text)).toEqual({ reason: text, removed: false });
    });
  }

  it("the lookbehind lets Ausflug and Ausflüge through but not Flug alone", () => {
    expect(REASON_BANNED.test("Ausflug")).toBe(false);
    expect(REASON_BANNED.test("Ausflüge")).toBe(false);
    expect(REASON_BANNED.test("Flug")).toBe(true);
    expect(REASON_BANNED.test("Flüge")).toBe(true);
  });

  it("works next to ö and ü (\\b would fail there)", () => {
    expect(REASON_BANNED.test("2 Std")).toBe(true);
    expect(REASON_BANNED.test("nur 3 Stunden")).toBe(true);
    expect(REASON_BANNED.test("5 Golfplätze")).toBe(false);
    expect(REASON_BANNED.test("5 Köche")).toBe(false);
  });

  it("strips markup and collapses whitespace", () => {
    expect(cleanReason("  **Schöne**   <b>Strände</b>\n und `Buchten`  ")).toEqual({ reason: "Schöne Strände und Buchten", removed: false });
  });

  it("cuts at 160 characters", () => {
    const long = "Sehr schöne Strände ".repeat(20);
    const r = cleanReason(long);
    expect(r.removed).toBe(false);
    expect(r.reason!.length).toBeLessThanOrEqual(160);
  });

  it("checks the full text: a banned fact behind the cut is still caught", () => {
    const r = cleanReason("Schöne Strände. ".repeat(12) + "Nur 2 h Flug.");
    expect(r).toEqual({ reason: null, removed: true });
  });

  it("empty is null and not counted as removed", () => {
    expect(cleanReason("   ")).toEqual({ reason: null, removed: false });
    expect(cleanReason("<br>")).toEqual({ reason: null, removed: false });
  });
});
