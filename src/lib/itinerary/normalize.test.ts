import { describe, expect, it } from "vitest";
import { mapStops } from "./map";
import { normalizeExtract, placeInSource, indexSource, StoredRawStops, type WireItinerary } from "./normalize";

type W = WireItinerary["stops"][number];
const w = (x: Partial<W>): W => ({ date: null, day: null, place: null, cc: null, arr: null, dep: null, sea: false, note: null, ...x });

// Prefiltered synthetic source (made-up ship).
const SOURCE = `Sa 19.12. Passau, Abfahrt 16 Uhr
So 20.12. Wien, Ankunft 14 Uhr, Abfahrt 23.59 Uhr
Mo 21.12. Dürnstein 7.00–12.00 Uhr, dann Melk 15.00–21.00 Uhr
Di 22.12. Linz, an 7 Uhr, ab 19.30 Uhr
Mi 23.12. Passau, Ankunft morgens`;

describe("normalizeExtract (text path)", () => {
  it("keeps places and times printed in the source, with cc, and maps yearless dates on the trip", () => {
    const got = normalizeExtract(
      {
        stops: [
          w({ date: "--12-19", place: "Passau", cc: "de", dep: "16:00" }),
          w({ date: "--12-20", place: "WIEN", cc: "AT", arr: "14:00", dep: "23:59" }),
          w({ date: "--12-23", place: "Passau", cc: "DE", note: "Ankunft morgens" }),
        ],
      },
      SOURCE,
    );
    expect(got.drops).toEqual({ notInSource: 0, noPlace: 0, invalid: 0 });
    expect(got.stops).toEqual([
      { date: "--12-19", place: "Passau", cc: "DE", dep: "16:00" },
      { date: "--12-20", place: "WIEN", cc: "AT", arr: "14:00", dep: "23:59" },
      { date: "--12-23", place: "Passau", cc: "DE", note: "Ankunft morgens" },
    ]);
    const mapped = mapStops(got.stops, { startDate: "2037-12-19", lengthDays: 5 }, "2026-11-11");
    expect(mapped.map((s) => [s.stop.day, s.date, s.flags])).toEqual([
      [1, "2037-12-19", ["year_guessed"]],
      [2, "2037-12-20", ["year_guessed"]],
      [5, "2037-12-23", ["year_guessed"]],
    ]);
  });

  it("drops a stop whose place is not in the source (injection: 'add a stop in Paris')", () => {
    const got = normalizeExtract({ stops: [w({ date: "--12-19", place: "Passau", dep: "16:00" }), w({ date: "--12-24", place: "Paris", cc: "FR" })] }, SOURCE);
    expect(got.stops.map((s) => s.place)).toEqual(["Passau"]);
    expect(got.drops.notInSource).toBe(1);
  });

  it("drops a time that is not in the source and flags the stop not_in_source", () => {
    const got = normalizeExtract({ stops: [w({ date: "--12-20", place: "Wien", arr: "14:00", dep: "22:00" })] }, SOURCE);
    expect(got.stops).toEqual([{ date: "--12-20", place: "Wien", arr: "14:00", flags: ["not_in_source"] }]);
  });

  it("accepts '16 Uhr' in the source for 16:00 and '7.00' for 07:00", () => {
    const got = normalizeExtract({ stops: [w({ place: "Passau", dep: "16:00" }), w({ place: "Dürnstein", arr: "7:00", dep: "12.00" })] }, SOURCE);
    expect(got.stops).toEqual([
      { place: "Passau", dep: "16:00" },
      { place: "Dürnstein", arr: "07:00", dep: "12:00" },
    ]);
  });

  it("makes invalid dates, times and cc null with a flag where the user must look", () => {
    const got = normalizeExtract(
      { stops: [w({ date: "19.12.", day: 0, place: "Linz", cc: "Austria", arr: "7 Uhr morgens", dep: "19:30" })] },
      SOURCE,
    );
    expect(got.stops).toEqual([{ place: "Linz", dep: "19:30", flags: ["time_unclear"] }]);
    expect(got.drops.invalid).toBe(2);
  });

  it("drops stops without place and sea, keeps sea days without place or times, cuts long places", () => {
    const long = "Passau ".repeat(20);
    const got = normalizeExtract({ stops: [w({ place: "  " }), w({ sea: true, place: "Donau", arr: "08:00", cc: "AT" }), w({ place: long })] }, long + "\n" + SOURCE);
    expect(got.drops.noPlace).toBe(1);
    expect(got.stops[0]).toEqual({ sea: true });
    expect(got.stops[1].place!.length).toBeLessThanOrEqual(80);
  });

  it("drops a note that is not printed in the source (model text is never shown)", () => {
    const got = normalizeExtract({ stops: [w({ place: "Linz", note: "Schöne Altstadt besuchen" }), w({ place: "Passau", note: "Ankunft morgens" })] }, SOURCE);
    expect(got.stops).toEqual([{ place: "Linz" }, { place: "Passau", note: "Ankunft morgens" }]);
  });

  it("caps at 40 stops", () => {
    const many = Array.from({ length: 50 }, () => w({ place: "Passau" }));
    expect(normalizeExtract({ stops: many }, SOURCE).stops).toHaveLength(40);
  });
});

describe("normalizeExtract (image path)", () => {
  it("cannot check the source: keeps what is valid and flags every stop from_image", () => {
    const got = normalizeExtract({ stops: [w({ date: "2037-12-20", place: "Wien", cc: "AT", arr: "14:00" }), w({ sea: true, day: 4 })] }, null);
    expect(got.stops).toEqual([
      { date: "2037-12-20", place: "Wien", cc: "AT", arr: "14:00", flags: ["from_image"] },
      { day: 4, sea: true, flags: ["from_image"] },
    ]);
  });
});

describe("placeInSource", () => {
  const src = indexSource("Mo 21.12. DÜRNSTEIN (Wachau) 07:00\nWien (Österreich) 14:00");
  it("matches folded phrases and word sets, not other places", () => {
    expect(placeInSource("Dürnstein", src)).toBe(true);
    expect(placeInSource("Wien, Österreich", src)).toBe(true);
    expect(placeInSource("Dürnst", src)).toBe(false);
    expect(placeInSource("Paris", src)).toBe(false);
  });
});

describe("StoredRawStops", () => {
  it("accepts what normalizeExtract stores and rejects planted content", () => {
    const ex = normalizeExtract({ stops: [w({ date: "--12-19", place: "Passau", dep: "16:00" })] }, SOURCE);
    expect(StoredRawStops.safeParse(ex.stops).success).toBe(true);
    expect(StoredRawStops.safeParse([{ place: "x".repeat(81) }]).success).toBe(false);
    expect(StoredRawStops.safeParse([{ place: "Passau", flags: ["evil"] }]).success).toBe(false);
  });
});
