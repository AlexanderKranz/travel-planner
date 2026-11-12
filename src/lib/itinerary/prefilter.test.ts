import { describe, expect, it } from "vitest";
import { MAX_ITINERARY_TEXT } from "@/lib/domain/itinerary";
import { parseItinerary } from "./parse";
import { isItineraryLine, prefilterItinerary } from "./prefilter";

// Synthetic document: made-up ship, passenger and booking number.
const DOC = `MS Beispiel · Reisebestätigung
Passagier: Erika Mustermann
Erika Mustermann
Buchungsnummer: XX-000000
Kabine 3012, Deck 2

Ihr Fahrplan
Datum Hafen Ankunft Abfahrt
Sa 19.12.2037 Passau – 16:00
So 20.12.2037 Wien 14:00 23:59
Mo 21.12.2037 Dürnstein 07:00 12:00
Erika Mustermann
Mo 21.12.2037 Melk 15:00 21:00
Preis pro Person: 1.299 €
Reiserücktrittsversicherung empfohlen. Es gelten unsere AGB.
Kontakt: info@example.org, Telefon 0000 000000`;

describe("prefilterItinerary", () => {
  const out = prefilterItinerary(DOC);

  it("keeps the rows and the column header", () => {
    expect(out.split("\n")).toEqual([
      "Datum Hafen Ankunft Abfahrt",
      "Sa 19.12.2037 Passau – 16:00",
      "So 20.12.2037 Wien 14:00 23:59",
      "Mo 21.12.2037 Dürnstein 07:00 12:00",
      "Mo 21.12.2037 Melk 15:00 21:00",
    ]);
  });

  it("drops names, booking and cabin numbers, prices, terms and contact data", () => {
    for (const gone of ["Mustermann", "XX-000000", "3012", "1.299", "AGB", "example.org", "Telefon"]) expect(out).not.toContain(gone);
  });

  it("keeps a place on its own line between two rows, but not a name line above the table", () => {
    const text = `Erika Mustermann
Samstag, 19.12.2037
Passau
Abfahrt 16:00`;
    expect(prefilterItinerary(text)).toBe("Samstag, 19.12.2037\nPassau\nAbfahrt 16:00");
  });

  it("keeps the place below a date-only row at the end of the text, but not a name before more prose", () => {
    expect(prefilterItinerary("20.12.2037 Wien an 14:00\n21.12.2037\nMelk")).toBe("20.12.2037 Wien an 14:00\n21.12.2037\nMelk");
    expect(prefilterItinerary("20.12.2037 Wien an 14:00\n21.12.2037\nMelk\n\n")).toBe("20.12.2037 Wien an 14:00\n21.12.2037\nMelk");
    expect(prefilterItinerary("21.12.2037\nErika Mustermann\nWir freuen uns auf Sie")).toBe("21.12.2037");
  });

  it("keeps untimed rows of a day-column table and its header, not a number line after the table", () => {
    const text = `Erika Mustermann
Tag | Hafen | an | ab
1 | Passau | – | 16:00
2 | Wien | – | –
3 | Melk | 15:00 | 21:00
4 Personen in Kabine 3012`;
    expect(prefilterItinerary(text).split("\n")).toEqual(["Tag | Hafen | an | ab", "1 | Passau | – | 16:00", "2 | Wien | – | –", "3 | Melk | 15:00 | 21:00"]);
    expect(parseItinerary(prefilterItinerary(text), { startDate: "2037-12-19", lengthDays: 5 }, "2026-11-11").stops.map((s) => s.stop)).toEqual([
      { day: 1, place: "Passau", dep: "16:00" },
      { day: 2, place: "Wien" },
      { day: 3, place: "Melk", arr: "15:00", dep: "21:00" },
    ]);
    // Without a day header a bare number line stays out.
    expect(prefilterItinerary("1 Passau ab 16:00\n2 Wien\n3 Melk an 15:00")).toBe("1 Passau ab 16:00\n3 Melk an 15:00");
  });

  it("collapses whitespace and caps at MAX_ITINERARY_TEXT on a line boundary", () => {
    expect(prefilterItinerary("19.12.2037\t Passau   ab 16:00")).toBe("19.12.2037 Passau ab 16:00");
    const long = Array.from({ length: 400 }, (_, i) => `Tag ${(i % 60) + 1} Hafen Nummer ${i} an 08:00 ab 18:00`).join("\n");
    const capped = prefilterItinerary(long);
    expect(capped.length).toBeLessThanOrEqual(MAX_ITINERARY_TEXT);
    expect(long.startsWith(capped)).toBe(true);
  });
});

describe("isItineraryLine", () => {
  it.each([
    "19.12.2037 Passau",
    "Sa 19. Dez Passau",
    "Dec 19 Passau",
    "2037-12-19",
    "Tag 3 Melk",
    "Day 3: Melk",
    "3. Tag Melk",
    "Abfahrt 16 Uhr",
    "dep 4 pm",
    "Seetag",
    "Day at sea",
    "Flusstag auf der Donau",
    "Mittwoch",
  ])("keeps %s", (line) => expect(isItineraryLine(line)).toBe(true));

  it.each(["Passagier: Erika Mustermann", "Buchungsnummer XX-000000", "Warme Jacke", "Preis 1.299 €"])("drops %s", (line) =>
    expect(isItineraryLine(line)).toBe(false),
  );
});
