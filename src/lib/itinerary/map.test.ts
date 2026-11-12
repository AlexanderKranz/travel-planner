import { describe, expect, it } from "vitest";
import { derivableStops, guessYear, isValidYearless, mapStops } from "./map";
import { findDate, findTimes, foldText, matchKey } from "./text";

const ctx = { startDate: "2037-12-19", lengthDays: 5 };
const TODAY = "2026-11-11";

describe("guessYear", () => {
  it("picks the year that puts the date inside the trip", () => {
    expect(guessYear("--12-20", ctx, TODAY)).toBe("2037-12-20");
    // A trip over New Year: January belongs to the next year.
    expect(guessYear("--01-02", { startDate: "2037-12-30", lengthDays: 5 }, TODAY)).toBe("2038-01-02");
    expect(guessYear("--12-30", { startDate: "2038-01-01", lengthDays: 3 }, TODAY)).toBe("2037-12-30");
  });

  it("picks the nearest year when the date is outside the trip", () => {
    expect(guessYear("--10-01", ctx, TODAY)).toBe("2037-10-01");
    expect(guessYear("--01-10", ctx, TODAY)).toBe("2038-01-10");
  });

  it("without trip dates takes the next occurrence on or after today", () => {
    expect(guessYear("--12-19", { startDate: null, lengthDays: 5 }, TODAY)).toBe("2026-12-19");
    expect(guessYear("--11-10", { startDate: null, lengthDays: 5 }, TODAY)).toBe("2027-11-10");
    expect(guessYear("--11-11", { startDate: null, lengthDays: 5 }, TODAY)).toBe("2026-11-11");
    expect(guessYear("--02-29", { startDate: null, lengthDays: 5 }, TODAY)).toBe("2028-02-29");
  });

  it("rejects invalid month/day", () => {
    expect(isValidYearless("--13-01")).toBe(false);
    expect(isValidYearless("--02-30")).toBe(false);
    expect(guessYear("--02-30", ctx, TODAY)).toBeNull();
  });
});

describe("mapStops", () => {
  it("maps dates to days with the start date in the form, keeps day numbers, sorts by day then time", () => {
    const got = mapStops(
      [
        { date: "2037-12-21", place: "Melk", arr: "15:00" },
        { date: "2037-12-21", place: "Dürnstein", arr: "07:00" },
        { day: 4, place: "Linz" },
      ],
      ctx,
      TODAY,
    );
    expect(got.map((s) => [s.stop.day, s.stop.place, s.date])).toEqual([
      [3, "Dürnstein", "2037-12-21"],
      [3, "Melk", "2037-12-21"],
      [4, "Linz", undefined],
    ]);
  });

  it("moves with the trip: the same raw stops on another start date", () => {
    const raw = [{ date: "2037-12-20", place: "Wien" }];
    expect(mapStops(raw, { startDate: "2037-12-18", lengthDays: 5 }, TODAY)[0].stop.day).toBe(3);
  });

  it("clamps a day outside the trip into a valid TripStop and flags it", () => {
    const got = mapStops([{ date: "2037-12-10", place: "Regensburg" }, { day: 9, place: "Linz" }], ctx, TODAY);
    expect(got).toEqual([
      { stop: { day: 1, place: "Regensburg" }, date: "2037-12-10", flags: ["outside_trip"] },
      { stop: { day: 9, place: "Linz" }, flags: ["outside_trip"] },
    ]);
    expect(derivableStops(got)).toEqual([]);
  });

  it("inherits the day of the stop before when a stop has neither date nor day, and drops a leading one", () => {
    const got = mapStops([{ place: "Ohne Tag" }, { day: 3, place: "Dürnstein" }, { place: "Melk" }], ctx, TODAY);
    expect(got.map((s) => [s.stop.day, s.stop.place])).toEqual([
      [3, "Dürnstein"],
      [3, "Melk"],
    ]);
  });

  it("keeps source flags, drops invalid stops and exact duplicates, and never sets cc on a sea day", () => {
    const got = mapStops(
      [
        { day: 2, place: "Wien", cc: "AT", arr: "14:00", flags: ["from_image"] },
        { day: 2, place: "wien", cc: "AT", arr: "14:00", flags: ["from_image"] },
        { day: 3, sea: true, cc: "AT" },
        { day: 4 },
        { day: 4, place: "Linz", arr: "7:00" },
      ],
      ctx,
      TODAY,
    );
    expect(got).toEqual([
      { stop: { day: 2, place: "Wien", cc: "AT", arr: "14:00" }, flags: ["from_image"] },
      { stop: { day: 3, sea: true }, flags: [] },
    ]);
  });

  it("prefers the date over a printed day number when the trip has a start date, the day number when not", () => {
    const raw = [{ date: "2037-12-21", day: 7, place: "Melk" }];
    expect(mapStops(raw, ctx, TODAY)[0].stop.day).toBe(3);
    expect(mapStops(raw, { startDate: null, lengthDays: 10 }, TODAY)[0]).toMatchObject({ stop: { day: 7 }, flags: ["no_trip_date"] });
  });
});

describe("text rules", () => {
  it("folds case, diacritics and ß for source checks", () => {
    expect(foldText("DÜRNSTEIN, Straße")).toBe("durnstein strasse");
    expect(matchKey("Dürnstein")).toBe("durnstein");
  });

  it("reads dates in the printed formats", () => {
    const d = (s: string) => {
      const h = findDate(matchKey(s));
      return h && [h.year, h.month, h.day];
    };
    expect(d("19.12.2037")).toEqual([2037, 12, 19]);
    expect(d("19.12.37")).toEqual([2037, 12, 19]);
    expect(d("Sa 19.12.")).toEqual([null, 12, 19]);
    expect(d("Sa 19. Dez")).toEqual([null, 12, 19]);
    expect(d("Dec 19, 2037")).toEqual([2037, 12, 19]);
    expect(d("19th December")).toEqual([null, 12, 19]);
    expect(d("2037-12-19")).toEqual([2037, 12, 19]);
    expect(d("19/12/2037")).toEqual([2037, 12, 19]);
    expect(d("05/06/2037")).toBeNull(); // US or EU order unknown
    expect(d("um 16.00 Uhr")).toBeNull();
    expect(d("Marbella")).toBeNull();
  });

  it("reads times, but not prices", () => {
    const t = (s: string) => findTimes(matchKey(s)).map((x) => x.hhmm);
    expect(t("an 7.30 ab 16:00 Uhr")).toEqual(["07:30", "16:00"]);
    expect(t("16 Uhr, 9h")).toEqual(["16:00", "09:00"]);
    expect(t("4 pm – 11:30 p.m.")).toEqual(["16:00", "23:30"]);
    expect(t("12 am")).toEqual(["00:00"]);
    expect(t("Ausflug 12.50 € oder 9.90 EUR")).toEqual([]);
    expect(t("25:00")).toEqual([]);
  });
});
