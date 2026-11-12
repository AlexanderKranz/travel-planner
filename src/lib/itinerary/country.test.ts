import { describe, expect, it } from "vitest";
import { countryCodeOf, splitCountrySuffix } from "./country";
import { normalizeExtract } from "./normalize";
import { parseItinerary } from "./parse";
import { prefilterItinerary } from "./prefilter";

describe("countryCodeOf", () => {
  it("German and English names and a few aliases", () => {
    expect(countryCodeOf("Italien")).toBe("IT");
    expect(countryCodeOf("Malta")).toBe("MT");
    expect(countryCodeOf("Spanien")).toBe("ES");
    expect(countryCodeOf("Frankreich")).toBe("FR");
    expect(countryCodeOf("Spain")).toBe("ES");
    expect(countryCodeOf("Türkei")).toBe("TR");
    expect(countryCodeOf("Turkey")).toBe("TR");
    expect(countryCodeOf("Großbritannien")).toBe("GB");
    expect(countryCodeOf("Mallorca")).toBeNull();
    expect(countryCodeOf("Sizilien")).toBeNull();
    expect(countryCodeOf("")).toBeNull();
  });
});

describe("splitCountrySuffix", () => {
  it("splits a trailing country only", () => {
    expect(splitCountrySuffix("Messina (Sizilien), Italien")).toEqual({ place: "Messina (Sizilien)", cc: "IT" });
    expect(splitCountrySuffix("La Valletta, Malta")).toEqual({ place: "La Valletta", cc: "MT" });
    expect(splitCountrySuffix("Palma, Mallorca")).toEqual({ place: "Palma, Mallorca" });
    expect(splitCountrySuffix("Messina (Sizilien)")).toEqual({ place: "Messina (Sizilien)" });
    expect(splitCountrySuffix(", Italien")).toEqual({ place: ", Italien" });
  });
});

// Synthetic cruise in the shape of an uploaded itinerary picture (made-up days, no real dates).
const CRUISE = `Tag 1. Barcelona, Spanien 18:00
Tag 2. Marseille, Frankreich 08:00 17:00
Tag 3. Genua, Italien 08:00 18:00
Tag 4. Neapel, Italien 08:00 18:00
Tag 5. Messina (Sizilien), Italien 08:00 18:00
Tag 6. La Valletta, Malta 08:00 18:00
Tag 7. Auf See
Tag 8. Barcelona, Spanien 07:00`;

describe("country after the port", () => {
  it("parser: the place keeps the port (and its parenthetical), the country becomes cc", () => {
    const r = parseItinerary(prefilterItinerary(CRUISE), { startDate: null, lengthDays: 8 }, "2026-11-12");
    expect(r.usable).toBe(true);
    expect(r.stops.map((s) => [s.stop.day, s.stop.place ?? "sea", s.stop.cc])).toEqual([
      [1, "Barcelona", "ES"],
      [2, "Marseille", "FR"],
      [3, "Genua", "IT"],
      [4, "Neapel", "IT"],
      [5, "Messina (Sizilien)", "IT"],
      [6, "La Valletta", "MT"],
      [7, "sea", undefined],
      [8, "Barcelona", "ES"],
    ]);
  });

  it("AI path: a country in the model's place becomes cc; the model's own cc wins", () => {
    const w = (place: string, cc: string | null) => ({ date: null, day: 5, place, cc, arr: null, dep: null, sea: false, note: null });
    const got = normalizeExtract({ stops: [w("Messina (Sizilien), Italien", null), w("La Valletta, Malta", "mt"), w("Neapel, Italien", "FR")] }, CRUISE);
    expect(got.stops.map((s) => [s.place, s.cc])).toEqual([
      ["Messina (Sizilien)", "IT"],
      ["La Valletta", "MT"],
      ["Neapel", "FR"],
    ]);
  });
});
