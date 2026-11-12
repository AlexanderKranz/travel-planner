import { describe, expect, it } from "vitest";
import { TripStops } from "@/lib/domain/trip-stops";
import {
  datesOffer,
  emptyRow,
  fillMissingRows,
  overfullDays,
  patchRow,
  remapRowsToStart,
  rowFlags,
  rowProblems,
  rowsFromExtracted,
  rowsFromStops,
  rowsHaveProblems,
  rowsToStops,
  firstPlace,
  tripFitFromRows,
  type StopRow,
} from "./stops-draft";

const row = (p: Partial<ReturnType<typeof emptyRow>>) => ({ ...emptyRow(), ...p });

describe("stop rows", () => {
  it("round-trips stops and validates against the schema", () => {
    const stops = [
      { day: 1, place: "Passau", dep: "16:00" },
      { day: 2, sea: true as const },
      { day: 3, place: "Melk", cc: "AT", arr: "15:00", dep: "21:00", note: "Anleger" },
    ];
    expect(rowsToStops(rowsFromStops(stops))).toEqual(stops);
    expect(TripStops.safeParse(rowsToStops(rowsFromStops(stops))).success).toBe(true);
  });

  it("drops the place and cc of a sea day and empty times", () => {
    const stop = rowsToStops([row({ day: 2, sea: true, place: "Wien", cc: "AT" })])[0];
    expect(stop).toEqual({ day: 2, sea: true });
  });

  it("sorts by day then time, stable", () => {
    const out = rowsToStops([
      row({ day: 3, place: "Melk", arr: "15:00" }),
      row({ day: 3, place: "Dürnstein", arr: "07:00" }),
      row({ day: 1, place: "Passau" }),
    ]);
    expect(out.map((s) => s.place)).toEqual(["Passau", "Dürnstein", "Melk"]);
  });

  it("reports a missing place and a day beyond the trip", () => {
    expect(rowProblems(row({ day: 1 }), 5)).toEqual(["place"]);
    expect(rowProblems(row({ day: 6, place: "X" }), 5)).toEqual(["day"]);
    expect(rowProblems(row({ day: 6, sea: true }), 5)).toEqual(["day"]);
    expect(rowProblems(row({ day: 2, sea: true }), 5)).toEqual([]);
  });

  it("computes outside_trip and no_trip_date live and keeps the others", () => {
    const [r] = rowsFromExtracted([
      { stop: { day: 9, place: "Linz" }, date: "2037-12-27", flags: ["outside_trip", "no_trip_date", "year_guessed"] },
    ]);
    expect(r!.flags).toEqual(["year_guessed"]);
    expect(rowFlags(r!, { startDate: "2037-12-19", lengthDays: 5 }).sort()).toEqual(["outside_trip", "year_guessed"]);
    expect(rowFlags(r!, { startDate: null, lengthDays: 14 }).sort()).toEqual(["no_trip_date", "year_guessed"]);
  });
});

describe("fillMissingRows", () => {
  it("adds only proposal rows on days without a stop", () => {
    const current = [row({ day: 1, place: "A" }), row({ day: 3, place: "B" })];
    const proposal = [row({ day: 1, place: "X" }), row({ day: 2, place: "Y" }), row({ day: 3, place: "Z" })];
    expect(fillMissingRows(current, proposal).map((r) => r.place)).toEqual(["A", "Y", "B"]);
  });
});

describe("datesOffer [D8]", () => {
  const dated = [row({ date: "2037-12-19" }), row({ date: "2037-12-23" })];
  it("offers the document range when the trip has no start", () => {
    expect(datesOffer(dated, { startDate: null, lengthDays: 7 })).toEqual({
      startDate: "2037-12-19",
      endDate: "2037-12-23",
      days: 5,
    });
  });
  it("offers it when a date falls outside the trip", () => {
    expect(datesOffer(dated, { startDate: "2037-12-20", lengthDays: 4 })?.days).toBe(5);
  });
  it("offers nothing when the dates fit or there are none", () => {
    expect(datesOffer(dated, { startDate: "2037-12-19", lengthDays: 5 })).toBeNull();
    expect(datesOffer([row({})], { startDate: null, lengthDays: 5 })).toBeNull();
  });
  it("moves dated rows to the new start", () => {
    const out = remapRowsToStart([row({ day: 9, date: "2037-12-21" }), row({ day: 2 })], "2037-12-19");
    expect(out.map((r) => r.day)).toEqual([3, 2]);
  });
});

describe("patchRow", () => {
  const row = { ...emptyRow(1), place: "Wien", cc: "AT" };
  it("drops the country hint when the place changes", () => expect(patchRow(row, { place: "Paris" }).cc).toBeUndefined());
  it("keeps it for other edits and an unchanged place", () => {
    expect(patchRow(row, { arr: "09:00" }).cc).toBe("AT");
    expect(patchRow(row, { place: "Wien" }).cc).toBe("AT");
  });
});

describe("overfullDays", () => {
  const row = (day: number, place = "Ort", sea = false) => ({ ...emptyRow(day), place: sea ? "" : place, sea });
  it("reports days with more than 4 places; sea rows do not count", () => {
    const rows = [1, 1, 1, 1, 1, 2, 2].map((d) => row(d)).concat([row(2, "", true)]);
    expect(overfullDays(rows)).toEqual([1]);
    expect(rowsHaveProblems(rows, 5)).toBe(true);
    expect(overfullDays(rows.slice(1))).toEqual([]);
  });
});

describe("tripFitFromRows and firstPlace", () => {
  const row = (day: number, place: string, extra: Partial<StopRow> = {}): StopRow => ({ ...emptyRow(day), place, ...extra });

  it("takes start date and length from printed dates when the form has no start date", () => {
    const rows = [row(1, "Passau", { date: "2037-05-03" }), row(1, "Wien", { date: "2037-05-07" })];
    const fit = tripFitFromRows(rows, { startDate: null, lengthDays: 3 });
    expect(fit.startDate).toBe("2037-05-03");
    expect(fit.lengthDays).toBe(5);
    expect(fit.stops.map((r) => r.day)).toEqual([1, 5]);
  });

  it("sets the length to the last stop day when the rows carry no dates", () => {
    const fit = tripFitFromRows([row(1, "Passau"), row(4, "", { sea: true }), row(8, "Wien")], { startDate: null, lengthDays: 3 });
    expect(fit).toMatchObject({ lengthDays: 8 });
    expect(fit.startDate).toBeUndefined();
  });

  it("adjusts the length also when printed dates fit the user's start date", () => {
    const rows = [row(1, "Passau", { date: "2037-05-03" }), row(2, "Linz", { date: "2037-05-04" })];
    expect(tripFitFromRows(rows, { startDate: "2037-05-03", lengthDays: 7 })).toMatchObject({ lengthDays: 2 });
  });

  it("counts undated rows for the length when only some rows carry a date", () => {
    const fit = tripFitFromRows([row(1, "Passau", { date: "2037-05-03" }), row(8, "Wien")], { startDate: null, lengthDays: 3 });
    expect(fit).toMatchObject({ startDate: "2037-05-03", lengthDays: 8 });
  });

  it("remaps dated rows to the user's start date before taking the length", () => {
    const rows = [row(1, "Passau", { date: "2037-05-03" }), row(2, "Linz", { date: "2037-05-04" })];
    const fit = tripFitFromRows(rows, { startDate: "2037-05-01", lengthDays: 7 });
    expect(fit.lengthDays).toBe(4);
    expect(fit.stops.map((r) => r.day)).toEqual([3, 4]);
  });

  it("leaves the user's start date and length alone when the printed dates do not fit it", () => {
    const rows = [row(1, "Passau", { date: "2037-06-01" })];
    const fit = tripFitFromRows(rows, { startDate: "2037-05-03", lengthDays: 7 });
    expect(fit.startDate).toBeUndefined();
    expect(fit.lengthDays).toBeUndefined();
  });

  it("offers the first port (by day, skipping sea days) as the destination", () => {
    expect(firstPlace([row(2, "Linz"), row(1, "", { sea: true }), row(1, "Passau", { cc: "DE" })])).toEqual({ name: "Passau", cc: "DE" });
    expect(firstPlace([row(1, "", { sea: true })])).toBeNull();
  });
});
