import { describe, expect, it, vi } from "vitest";
import type { Plan } from "@/lib/domain/plan";
import type { PlanInputStored } from "./input";
import { extendInputWithStops, stopPointsOf, stopRows } from "./stops-input";
import { MAX_NOTICE_PLACES, hasUnknownSchedule, patchNotice } from "./stops-notice";
import { CRUISE_FACTS, CRUISE_RESOLVED, CRUISE_STOPS, emptyStored } from "./stops-test-helpers";

vi.mock("server-only", () => ({}));

const plan = (stops: { place: string; fixed?: boolean }[][]): Plan =>
  ({ days: stops.map((s, i) => ({ n: i + 1, date: null, title: `T${i + 1}`, stops: s.map((x) => ({ ...x, acts: [] })) })) }) as unknown as Plan;
const base = plan([[{ place: "Passau", fixed: true }], [{ place: "Wien", fixed: true }], [{ place: "Dürnstein", fixed: true }], [{ place: "An Bord" }], [{ place: "Passau" }]]);
const names = ["Donau", "Passau"];

const stored = (facts = CRUISE_FACTS): PlanInputStored =>
  extendInputWithStops(emptyStored(), { rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED), points: stopPointsOf(CRUISE_RESOLVED), facts, lang: "de" });
const failedRest = { status: "error" as const, restaurants: [] };
const ask = (s: PlanInputStored, over: Partial<Parameters<typeof patchNotice>[0]> = {}) => patchNotice({ stored: s, scopeDays: [], tripHasStops: true, base, destinationNames: names, ...over });

describe("patchNotice (port-places section 5): the first notice that applies", () => {
  it("nothing wrong with the stops: no notice (the client shows noChange and the reply)", () => {
    expect(ask(stored())).toBeNull();
  });

  it("2: a stop in scope that was not found, with its name", () => {
    const bad = { ...CRUISE_FACTS[2], stop: { ...CRUISE_FACTS[2].stop, status: "not_found" as const, point: undefined }, places: [] };
    expect(ask(stored([CRUISE_FACTS[1], bad]))).toEqual({ code: "stops_not_found", places: ["Dürnstein"] });
  });

  it("3: lookups that failed (after the retry), also a failed restaurants block", () => {
    const failed = { ...CRUISE_FACTS[2], places: [], restaurants: failedRest };
    expect(ask(stored([CRUISE_FACTS[1], failed]))).toEqual({ code: "stops_unchecked", places: ["Dürnstein"] });
    const geocodeError = { ...CRUISE_FACTS[2], stop: { ...CRUISE_FACTS[2].stop, status: "error" as const, point: undefined }, places: [] };
    expect(ask(stored([CRUISE_FACTS[1], geocodeError]))).toEqual({ code: "stops_unchecked", places: ["Dürnstein"] });
  });

  it("4: a stop over the cap", () => {
    const capped = { ...CRUISE_FACTS[2], stop: { ...CRUISE_FACTS[2].stop, status: "cap" as const, point: undefined }, places: [] };
    expect(ask(stored([CRUISE_FACTS[1], capped]))).toEqual({ code: "stops_capped", places: ["Dürnstein"] });
  });

  it("the order: not found before unchecked before capped", () => {
    const nf = { ...CRUISE_FACTS[1], stop: { ...CRUISE_FACTS[1].stop, status: "not_found" as const, point: undefined }, places: [] };
    const failed = { ...CRUISE_FACTS[2], places: [], restaurants: failedRest };
    expect(ask(stored([nf, failed]))?.code).toBe("stops_not_found");
    const capped = { ...CRUISE_FACTS[1], stop: { ...CRUISE_FACTS[1].stop, status: "cap" as const, point: undefined }, places: [] };
    expect(ask(stored([capped, failed]))?.code).toBe("stops_unchecked");
  });

  it("only stops in scope count: FEEDBACK.days, else every day", () => {
    const failed = { ...CRUISE_FACTS[2], places: [], restaurants: failedRest }; // Dürnstein, day 3
    const s = stored([CRUISE_FACTS[1], failed]);
    expect(ask(s, { scopeDays: [2] })).toBeNull();
    expect(ask(s, { scopeDays: [3] })?.code).toBe("stops_unchecked");
    expect(ask(s, { scopeDays: [2, 3] })?.code).toBe("stops_unchecked");
  });

  it("names are limited to three", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ day: i + 1, place: `Ort${i}` }));
    const s = emptyStored();
    s.llm.trip.stops = rows.map((r, i) => ({ ...r, at: `s${i + 1}` }));
    s.llm.stopPlaces = rows.map((r, i) => ({ id: `s${i + 1}`, name: r.place, s: "not_found" as const }));
    expect(ask(s)?.places).toEqual(["Ort0", "Ort1", "Ort2"]);
    expect(MAX_NOTICE_PLACES).toBe(3);
  });

  it("5: the trip has no stops the app knows, but the base plan has a scheduled stop that is not the destination", () => {
    expect(ask(emptyStored(), { tripHasStops: false })).toEqual({ code: "stops_unknown", places: [] });
    expect(ask(emptyStored(), { tripHasStops: false, scopeDays: [4] })).toBeNull(); // day 4 has no fixed window
    expect(ask(emptyStored(), { tripHasStops: false, base: plan([[{ place: "Passau", fixed: true }]]) })).toBeNull(); // the destination itself
    expect(ask(emptyStored(), { tripHasStops: false, base: plan([[{ place: "Altstadt" }, { place: "Dom" }]]) })).toBeNull(); // ordinary sub-areas
    expect(ask(emptyStored(), { tripHasStops: true })).toBeNull();
  });

  it("hasUnknownSchedule needs a fixed window", () => {
    expect(hasUnknownSchedule(base, [], names)).toBe(true);
    expect(hasUnknownSchedule(plan([[{ place: "Wien" }]]), [], names)).toBe(false);
  });
});
