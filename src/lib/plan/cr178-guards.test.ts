import { describe, expect, it, vi } from "vitest";
import type { LlmPlan, PlanActivity, PlanDay, PlanStop } from "@/lib/domain/plan";
import type { StopFacts } from "@/lib/domain/facts";
import { TripStops, type TripStop } from "@/lib/domain/trip-stops";
import { assemblePlan, inputTimes, ownTimes } from "./assemble";
import { keepFixedStops } from "./patch";
import { placeMatches } from "./place-match";
import { applyPortWindows } from "./port-windows";
import { guardStopRefs, refAllowed, stopRefCtx } from "./stop-refs";
import { extendInputWithStops, stopPointsOf, stopRows } from "./stops-input";
import { CRUISE_RESOLVED, cand, emptyStored, group, okRestaurants, rest, stopOk } from "./stops-test-helpers";
import { header } from "./test-helpers";

vi.mock("server-only", () => ({}));

const stop = (place: string, over: Partial<PlanStop> = {}): PlanStop => ({ place, acts: [], ...over });
const MELK = { lat: 48.228, lon: 15.333, geoId: 2769000 };

describe("placeMatches matches complete names (finding 1)", () => {
  it("a longer name is another place; explicit sub-areas still match", () => {
    expect(placeMatches("Wiener Neustadt", "Wien")).toBe(false);
    expect(placeMatches("Wien", "Wiener Neustadt")).toBe(false);
    expect(placeMatches("Wien: Innenstadt", "Wien")).toBe(true);
    expect(placeMatches("Melk (Stift)", "Melk")).toBe(true);
    expect(placeMatches("Wien", "Wien: Innenstadt")).toBe(true);
    expect(placeMatches("Dürnstein", "durnstein")).toBe(true);
    expect(placeMatches("Baden-Baden", "Baden")).toBe(false);
  });
});

// Day 2 Wien, day 3 Dürnstein then Melk; Wien and Dürnstein both list place 500; Melk has its own restaurant.
const TWO_STOPS: TripStop[] = [
  { day: 1, place: "Passau", dep: "16:00" },
  { day: 2, place: "Wien", arr: "14:00", dep: "23:59" },
  { day: 3, place: "Dürnstein", arr: "07:00", dep: "12:00" },
  { day: 3, place: "Melk", arr: "13:00", dep: "18:00" },
  { day: 4, place: "Passau", arr: "08:00" },
];
const RESOLVED = [...CRUISE_RESOLVED.slice(0, 3), stopOk("s3", "Melk", [3], MELK)];
const FACTS: StopFacts[] = [
  { stop: RESOLVED[0], places: [] },
  { stop: RESOLVED[1], places: [group("general", [cand(500, "Gemeinsam", 48.3, 15.9), cand(501, "Wien-Ding", 48.2, 16.37)])] },
  { stop: RESOLVED[2], places: [group("general", [cand(500, "Gemeinsam", 48.3, 15.9)])], restaurants: okRestaurants([rest(600, "Durnstein Wirt", 48.395, 15.519)]) },
  { stop: RESOLVED[3], places: [], restaurants: okRestaurants([rest(601, "Melker Wirt", 48.228, 15.333)]) },
];
const stored = () =>
  extendInputWithStops(emptyStored(4), { rows: stopRows(TWO_STOPS, RESOLVED), points: stopPointsOf(RESOLVED), facts: FACTS, lang: "de" });
const keyOf = (s: ReturnType<typeof stored>, osm: number) => Object.values(s.index).find((e) => e.key === `node/${osm}`)!.key;

describe("stop-ref guard checks the containing plan stop (finding 2)", () => {
  const s = stored();
  const ctx = stopRefCtx(s)!;
  const melkRest = keyOf(s, 601);
  const durnRest = keyOf(s, 600);
  it("a Melk restaurant inside the Dürnstein plan stop is rejected, inside Melk it is allowed", () => {
    expect(refAllowed(melkRest, 3, ctx)).toBe(true); // by the day alone
    expect(refAllowed(melkRest, 3, ctx, "Dürnstein")).toBe(false);
    expect(refAllowed(melkRest, 3, ctx, "Melk (Stift)")).toBe(true);
    expect(refAllowed(durnRest, 3, ctx, "Melk")).toBe(false);
    expect(refAllowed(durnRest, 3, ctx, "Dürnstein")).toBe(true);
  });
  it("a plan stop no row names falls back to the day", () => {
    expect(refAllowed(melkRest, 3, ctx, "An Bord")).toBe(true);
  });
  it("guardStopRefs passes the plan stop through", () => {
    const act: PlanActivity = { kind: "food", text: "Essen", ref: melkRest };
    expect(guardStopRefs(act, 3, ctx, "Dürnstein").dropped).toBe(1);
    expect(guardStopRefs(act, 3, ctx, "Melk").dropped).toBe(0);
  });
});

describe("a place two stops' lookups return (finding 3)", () => {
  const s = stored();
  const ctx = stopRefCtx(s)!;
  const shared = keyOf(s, 500);
  it("the input lists the id under both stops and the index tags only the first", () => {
    const listed = s.llm.stopPlaces!.map((p) => (p.places ?? []).some((x) => s.index[x.id]?.key === shared));
    expect(listed).toEqual([true, true, false]);
    expect(Object.values(s.index).find((e) => e.key === shared)!.stop).toBe("s1");
  });
  it("is allowed on the days of both stops and nowhere else", () => {
    expect(refAllowed(shared, 2, ctx)).toBe(true);
    expect(refAllowed(shared, 3, ctx)).toBe(true);
    expect(refAllowed(shared, 3, ctx, "Dürnstein")).toBe(true);
    expect(refAllowed(shared, 3, ctx, "Melk")).toBe(false);
    expect(refAllowed(shared, 1, ctx)).toBe(false);
    expect(refAllowed(shared, 4, ctx)).toBe(false);
  });
});

describe("activity times outside a confirmed window (finding 4)", () => {
  const rows = [{ day: 2, place: "Wien", arr: "14:00", dep: "18:00", at: "s1" }];
  it("drops the times of activities outside, keeps the activity and the ones inside", () => {
    const acts: PlanActivity[] = [
      { kind: "see", text: "Früh", at: "09:00", until: "10:00" },
      { kind: "see", text: "Drin", at: "15:00", until: "16:00" },
      { kind: "see", text: "Ende", at: "17:00", until: "19:00" },
    ];
    const r = applyPortWindows([stop("Wien", { from: "09:00", to: "20:00", acts })], rows);
    expect(r.clipped).toBe(2);
    expect(r.stops[0].acts).toEqual([
      { kind: "see", text: "Früh" },
      { kind: "see", text: "Drin", at: "15:00", until: "16:00" },
      { kind: "see", text: "Ende", at: "17:00" },
    ]);
  });
  it("a window past midnight keeps late and early times", () => {
    const acts: PlanActivity[] = [{ kind: "do", text: "Nacht", at: "23:00", until: "00:30" }];
    const r = applyPortWindows([stop("Wien", { acts })], [{ day: 2, place: "Wien", arr: "22:00", dep: "02:00" }]);
    expect(r.clipped).toBe(0);
  });
  it("assemblePlan counts them as window_violation", () => {
    const s = stored();
    const llm: LlmPlan = {
      summary: "x",
      days: [1, 2, 3, 4].map((n) => ({
        n,
        title: `T${n}`,
        stops: [{ place: n === 2 ? "Wien" : "Passau", acts: n === 2 ? [{ kind: "see", text: "Früh", at: "09:00" }] : [] }],
      })),
      notes: [],
      open: [],
      packing: [],
    };
    const r = assemblePlan({ llm, stored: s, header: { ...header(4), lengthDays: 4, timing: { kind: "none" } }, digest: {}, locale: "de" });
    expect(r.ok && r.plan.days[1].stops[0].acts[0].at).toBeUndefined();
    expect(r.ok && r.issues.window_violation).toBe(1);
  });
});

describe("a patch after the user changed a confirmed time (finding 5)", () => {
  const base: PlanDay = { n: 5, date: null, title: "T", stops: [stop("Passau", { from: "08:00", fixed: true })] };
  const next: PlanDay = { n: 5, date: null, title: "T", stops: [stop("Passau", { from: "09:00", fixed: true })] };
  it("the current window wins over the base window", () => {
    const r = keepFixedStops(base, next, [{ day: 5, place: "Passau", arr: "09:00", at: "dest" }]);
    expect(r.stops).toEqual(next.stops);
  });
  it("without a current row the base window is still restored", () => {
    const moved = { ...next, stops: [stop("Passau", { from: "09:00" })] };
    expect(keepFixedStops(base, moved).stops[0]).toMatchObject({ from: "08:00", fixed: true });
  });
});

describe("structured times belong to their own day and stop (finding 6)", () => {
  const s = stored();
  const llm = (acts: PlanActivity[]): LlmPlan => ({
    summary: "x",
    days: [1, 2, 3, 4].map((n) => ({ n, title: `T${n}`, stops: [{ place: n === 2 ? "Wien" : "Passau", acts: n === 2 ? acts : [] }] })),
    notes: [],
    open: [],
    packing: [],
  });
  it("inputTimes holds the notes' times only; ownTimes adds the matching row's", () => {
    const plain = { ...s, llm: { ...s.llm, trip: { ...s.llm.trip, notes: undefined } } };
    expect(inputTimes(plain).size).toBe(0);
    const rows = s.llm.trip.stops!.filter((r) => r.day === 1);
    expect([...ownTimes(new Set(), rows, "Passau")]).toEqual(["16:00"]);
    expect([...ownTimes(new Set(), rows, "Wien")]).toEqual([]);
  });
  it("a day-2 arrival time equal to day 1's departure is dropped as invented; a row's own time stays", () => {
    const notesStored = { ...s, llm: { ...s.llm, trip: { ...s.llm.trip, notes: "Wien am Nachmittag" } } };
    const run = (at: string) =>
      assemblePlan({
        llm: llm([{ kind: "travel", text: "Ankunft in Wien", at }]),
        stored: notesStored,
        header: { ...header(4), lengthDays: 4, timing: { kind: "none" } },
        digest: {},
        locale: "de",
      });
    const bad = run("16:00"); // day 1's departure, not Wien's
    expect(bad.ok && bad.plan.days[1].stops[0].acts[0].at).toBeUndefined();
    expect(bad.ok && bad.issues.invented_time).toBe(1);
    const good = run("14:00"); // Wien's own arrival row
    expect(good.ok && good.plan.days[1].stops[0].acts[0].at).toBe("14:00");
  });
});

describe("TripStops limits places per day (finding 7)", () => {
  const at = (n: number, extra: Partial<TripStop> = {}): TripStop => ({ day: 1, place: `Ort ${n}`, ...extra });
  it("accepts 4 places plus sea rows on a day, rejects the 5th place with a path to it", () => {
    expect(TripStops.safeParse([1, 2, 3, 4].map((n) => at(n))).success).toBe(true);
    expect(TripStops.safeParse([...[1, 2, 3, 4].map((n) => at(n)), { day: 1, sea: true }]).success).toBe(true);
    const r = TripStops.safeParse([1, 2, 3, 4, 5].map((n) => at(n, { arr: "08:00" })));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]).toMatchObject({ path: [4, "day"], message: "stopsPerDay" });
  });
  it("counts per day", () => {
    expect(TripStops.safeParse([1, 2, 3, 4].flatMap((n) => [at(n), { day: 2, place: `Ort ${n}` }])).success).toBe(true);
  });
});
