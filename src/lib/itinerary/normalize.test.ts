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

describe("normalizeExtract: day-parts and notes", () => {
  it("turns a day-part in a time field into the note (recorded: arr 'morgens' from the photo)", () => {
    const got = normalizeExtract({ stops: [w({ date: "2037-12-23", place: "Passau", cc: "DE", arr: "morgens" })] }, null);
    expect(got.stops).toEqual([{ date: "2037-12-23", place: "Passau", cc: "DE", note: "Ankunft morgens", flags: ["from_image"] }]);
    const en = normalizeExtract({ stops: [w({ place: "Passau", arr: "in the morning" })] }, "Dec 23 - back in Passau in the morning");
    expect(en.stops).toEqual([{ place: "Passau", note: "Arrival morning" }]);
  });

  it("keeps a printed remark but not a whole row or sentence (recorded: notes that repeated the line)", () => {
    const src = "Dec 19 - board in Passau, the ship leaves at 4 pm\nDec 23 - back in Passau in the morning";
    const got = normalizeExtract(
      { stops: [w({ place: "Passau", note: "board in Passau, the ship leaves at 4 pm" }), w({ place: "Passau", note: "in the morning" })] },
      src,
    );
    expect(got.stops.map((s) => s.note)).toEqual([undefined, "in the morning"]);
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

  it("needs the place within one source line, not words from different rows", () => {
    const rows = indexSource("Sa 19.12. New Orleans an 08:00\nSo 20.12. York ab 18:00");
    expect(placeInSource("New York", rows)).toBe(false);
    expect(placeInSource("New Orleans", rows)).toBe(true);
    const got = normalizeExtract({ stops: [w({ date: "--12-19", place: "New York", arr: "08:00" })] }, "Sa 19.12. New Orleans an 08:00\nSo 20.12. York ab 18:00");
    expect(got).toEqual({ stops: [], drops: { notInSource: 1, noPlace: 0, invalid: 0 } });
  });
});

describe("normalizeExtract: dates and day numbers on the text path", () => {
  it("keeps a date printed on the stop's line or on a date-only line above it", () => {
    const src = "Sa 19.12.2037\nPassau ab 16:00\nSo 20.12. Wien an 14:00";
    const got = normalizeExtract({ stops: [w({ date: "2037-12-19", place: "Passau", dep: "16:00" }), w({ date: "2037-12-20", place: "Wien", arr: "14:00" })] }, src);
    expect(got.stops).toEqual([
      { date: "2037-12-19", place: "Passau", dep: "16:00" },
      { date: "2037-12-20", place: "Wien", arr: "14:00" },
    ]);
  });

  it("drops a date that is not printed for the stop and flags it (a wrong date would move the stop)", () => {
    const got = normalizeExtract({ stops: [w({ date: "--12-21", place: "Wien", arr: "14:00" }), w({ date: "2037-12-24", place: "Passau" })] }, SOURCE);
    expect(got.stops).toEqual([
      { place: "Wien", arr: "14:00", flags: ["not_in_source"] },
      { place: "Passau", flags: ["not_in_source"] },
    ]);
    const mapped = mapStops(got.stops, { startDate: "2037-12-19", lengthDays: 5 }, "2026-11-11");
    expect(mapped.every((s) => s.flags.includes("not_in_source"))).toBe(true);
  });

  it("never takes a year from the model: unprinted years become --MM-DD, a year from an earlier full date counts", () => {
    expect(normalizeExtract({ stops: [w({ date: "2036-12-19", place: "Passau" })] }, SOURCE).stops).toEqual([{ date: "--12-19", place: "Passau" }]);
    const src = "19.12.2037 Passau ab 16:00\n20.12. Wien an 14:00";
    expect(normalizeExtract({ stops: [w({ date: "2037-12-20", place: "Wien" }), w({ date: "2036-12-19", place: "Passau" })] }, src).stops).toEqual([
      { date: "2037-12-20", place: "Wien" },
      { place: "Passau", flags: ["not_in_source"] },
    ]);
  });

  it("checks day numbers the same way, including a bare day column and sea days", () => {
    const src = "Tag | Hafen | an | ab\n1 | Passau | – | 16:00\n2 | Wien | 14:00 | 23:59\nTag 3 Seetag";
    const got = normalizeExtract(
      { stops: [w({ day: 1, place: "Passau", dep: "16:00" }), w({ day: 3, place: "Wien", arr: "14:00" }), w({ day: 3, sea: true }), w({ day: 4, sea: true })] },
      src,
    );
    expect(got.stops).toEqual([
      { day: 1, place: "Passau", dep: "16:00" },
      { place: "Wien", arr: "14:00", flags: ["not_in_source"] },
      { day: 3, sea: true },
      { sea: true, flags: ["not_in_source"] },
    ]);
  });

  it("image path: dates and days are kept (nothing to check)", () => {
    expect(normalizeExtract({ stops: [w({ date: "2037-12-21", day: 9, place: "Wien" })] }, null).stops).toEqual([
      { date: "2037-12-21", day: 9, place: "Wien", flags: ["from_image"] },
    ]);
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

describe("indexSource times", () => {
  it("knows the start hour of a range with the unit at the end, and noon", () => {
    const src = indexSource("21.12. Dürnstein (7 bis 12 Uhr), Melk 15-21 h\nDec 21 Melk 3 to 9 pm, Dürnstein 7 am to noon");
    for (const t of ["07:00", "12:00", "15:00", "21:00"]) expect(src.times.has(t)).toBe(true);
    expect(src.times.has("08:00")).toBe(false);
  });
});
