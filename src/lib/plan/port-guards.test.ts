import { describe, expect, it, vi } from "vitest";
import type { LlmPlan, PlanActivity, PlanStop } from "@/lib/domain/plan";
import { assemblePlan, emptyIssues, inputTimes } from "./assemble";
import { applyPortWindows, rowTimes } from "./port-windows";
import { placeMatches } from "./place-match";
import { DEST_GRACE_KM, guardStopRefs, refAllowed, stopRefCtx } from "./stop-refs";
import { extendInputWithStops, stopRows, stopPointsOf } from "./stops-input";
import { CRUISE_FACTS, CRUISE_RESOLVED, CRUISE_STOPS, PASSAU, emptyStored } from "./stops-test-helpers";
import { header } from "./test-helpers";

vi.mock("server-only", () => ({}));

const stop = (place: string, over: Partial<PlanStop> = {}): PlanStop => ({ place, acts: [], ...over });

describe("placeMatches", () => {
  it("ignores accents and case, either name may contain the other", () => {
    expect(placeMatches("Dürnstein", "durnstein")).toBe(true);
    expect(placeMatches("Wien: Innenstadt", "Wien")).toBe(true);
    expect(placeMatches("Melk (Stift)", "Melk")).toBe(true);
    expect(placeMatches("Linz", "Wien")).toBe(false);
  });
});

describe("port-window guard", () => {
  const rows = stopRows(CRUISE_STOPS, CRUISE_RESOLVED);
  it("a stop row with times fixes the matching plan stop: fixed, from, to from the row", () => {
    const r = applyPortWindows([stop("An Bord"), stop("Wien: Innenstadt", { from: "09:00", to: "18:00" })], rows.filter((x) => x.day === 2));
    expect(r.missing).toBe(0);
    expect(r.stops[1]).toEqual({ place: "Wien: Innenstadt", from: "14:00", to: "23:59", fixed: true, acts: [] });
    expect(r.stops[0]).toEqual(stop("An Bord"));
  });
  it("one-sided rows give one-sided windows (the model's other time is removed)", () => {
    const dep = applyPortWindows([stop("Passau", { from: "10:00" })], rows.filter((x) => x.day === 1)).stops[0];
    expect(dep).toEqual({ place: "Passau", to: "16:00", fixed: true, acts: [] });
    const arr = applyPortWindows([stop("Passau", { to: "12:00" })], rows.filter((x) => x.day === 5)).stops[0];
    expect(arr).toEqual({ place: "Passau", from: "08:00", fixed: true, acts: [] });
  });
  it("no matching plan stop counts as missing; rows without times and sea rows need nothing", () => {
    expect(applyPortWindows([stop("Linz")], rows.filter((x) => x.day === 2)).missing).toBe(1);
    expect(applyPortWindows([stop("Linz")], [{ day: 2, place: "Wien" }]).missing).toBe(0);
    expect(applyPortWindows([stop("Linz")], rows.filter((x) => x.day === 4))).toEqual({ stops: [stop("Linz")], missing: 0 });
  });
  it("each plan stop takes one row only", () => {
    const r = applyPortWindows([stop("Melk")], [{ day: 3, place: "Melk", arr: "15:00", dep: "21:00" }, { day: 3, place: "Melk", arr: "22:00" }]);
    expect(r.missing).toBe(1);
    expect(r.stops[0].from).toBe("15:00");
  });
  it("rowTimes lists every arr and dep", () => {
    expect(rowTimes(rows)).toEqual(["16:00", "14:00", "23:59", "07:00", "12:00", "08:00"]);
  });
});

const withStops = () =>
  extendInputWithStops(emptyStored(), { rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED), points: stopPointsOf(CRUISE_RESOLVED), facts: CRUISE_FACTS, lang: "de" });

describe("stop-ref guard (port-places section 3)", () => {
  const stored = withStops();
  const ctx = stopRefCtx(stored)!;
  const zoo = stored.index.p2.key; // a place of Wien (s1)
  const dom = stored.index.p1.key; // a place of the destination
  const wineryKey = stored.index.r3?.key ?? stored.index.r2.key; // a restaurant of Dürnstein (s2)

  it("has no context without trip.stops", () => {
    expect(stopRefCtx(emptyStored())).toBeUndefined();
  });

  it("the context: days per stop, destination days, sea-only days", () => {
    expect(ctx.days).toEqual({ s1: [2], s2: [3] });
    expect([...ctx.destDays].sort()).toEqual([1, 5]);
    expect([...ctx.seaOnly]).toEqual([4]);
  });

  it("a stop's place only on a day of that stop", () => {
    expect(refAllowed(zoo, 2, ctx)).toBe(true);
    expect(refAllowed(zoo, 3, ctx)).toBe(false);
    expect(refAllowed(zoo, 1, ctx)).toBe(false);
    expect(refAllowed(zoo, 4, ctx)).toBe(false);
  });

  it("a destination place on destination days; not on a stop day unless within 10 km of its stop point", () => {
    expect(refAllowed(dom, 1, ctx)).toBe(true);
    expect(refAllowed(dom, 5, ctx)).toBe(true);
    expect(refAllowed(dom, 2, ctx)).toBe(false); // Passau is ~250 km from Wien
    const near = { ...ctx, pointOfKey: new Map([...ctx.pointOfKey, [dom, { lat: 48.2085, lon: 16.4 }]]) };
    expect(refAllowed(dom, 2, near)).toBe(true); // ~2 km from the Wien point
    const farther = { ...ctx, pointOfKey: new Map([...ctx.pointOfKey, [dom, { lat: 48.2085 + 0.15, lon: 16.3721 }]]) };
    expect(DEST_GRACE_KM).toBe(10);
    expect(refAllowed(dom, 2, farther)).toBe(false);
  });

  it("on a day with only sea rows every ref is dropped, destination places too", () => {
    expect(refAllowed(dom, 4, ctx)).toBe(false);
    expect(refAllowed(zoo, 4, ctx)).toBe(false);
  });

  it("days with no row at all are destination days", () => {
    const s = emptyStored(6);
    const more = extendInputWithStops(s, { rows: stopRows(CRUISE_STOPS, CRUISE_RESOLVED), points: stopPointsOf(CRUISE_RESOLVED), facts: CRUISE_FACTS, lang: "de" });
    const c = stopRefCtx(more)!;
    expect(c.destDays.has(6)).toBe(true);
    expect(refAllowed(more.index.p1.key, 6, c)).toBe(true);
  });

  const act = (over: Partial<PlanActivity>): PlanActivity => ({ kind: "see", text: "Besuch", ...over });
  it("a dropped ref is replaced by the first valid alternative; without one the text stays with no ref", () => {
    const swapped = guardStopRefs(act({ ref: zoo, alts: [dom, stored.index.p3.key] }), 3, ctx);
    expect(swapped.dropped).toBe(3); // all three are Wien or Passau places on a Dürnstein day
    expect(swapped.act.ref).toBeUndefined();
    const ok = guardStopRefs(act({ ref: zoo, alts: [stored.index.p3.key] }), 2, ctx);
    expect(ok).toEqual({ act: act({ ref: zoo, alts: [stored.index.p3.key] }), dropped: 0 });
    const replaced = guardStopRefs(act({ ref: dom, alts: [zoo] }), 2, ctx);
    expect(replaced.act).toEqual(act({ ref: zoo }));
    expect(replaced.dropped).toBe(1);
    const none = guardStopRefs(act({ ref: zoo }), 5, ctx);
    expect(none.act).toEqual(act({}));
    expect(guardStopRefs(act({}), 5, ctx)).toEqual({ act: act({}), dropped: 0 });
    expect(wineryKey).toBeTruthy();
  });

  it("emptyIssues counts both new issues", () => {
    expect(emptyIssues()).toMatchObject({ stop_mismatch: 0, port_window_missing: 0 });
    expect(PASSAU.geoId).toBeGreaterThan(0);
  });
});

describe("assemblePlan with stops (both guards run in assembleDay)", () => {
  const stored = withStops();
  const llm = (days: LlmPlan["days"]): LlmPlan => ({ summary: "Donau.", days, notes: [], open: [], packing: [] });
  const wienRest = stored.llm.stopPlaces![0].restaurants!.list[0].id;
  const wienPlace = stored.llm.stopPlaces![0].places![0].id;
  const day = (n: number, place: string, acts: LlmPlan["days"][number]["stops"][number]["acts"], extra: Partial<PlanStop> = {}) => ({ n, title: `Tag ${n}`, stops: [{ place, ...extra, acts }] });
  const run = (days: LlmPlan["days"]) =>
    assemblePlan({
      llm: llm(days),
      stored,
      header: { ...header(5), lengthDays: 5, timing: { kind: "none" } },
      digest: {},
      locale: "de",
    });

  it("applies the port window to the stop and drops refs on the wrong day", () => {
    const r = run([
      day(1, "Passau", [{ kind: "see", text: "Bummel", ref: "p1" }]),
      day(2, "Wien", [{ kind: "food", text: "Mittagessen", ref: wienRest }, { kind: "see", text: "Dom", ref: "p1" }]),
      day(3, "Dürnstein", [{ kind: "see", text: "Spaziergang", ref: wienPlace }]),
      day(4, "An Bord", [{ kind: "rest", text: "Ruhe", ref: "p1" }]),
      day(5, "Passau", [{ kind: "see", text: "Ausschiffung" }]),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [d1, d2, d3, d4] = r.plan.days;
    expect(d1.stops[0]).toMatchObject({ place: "Passau", to: "16:00", fixed: true });
    expect(d2.stops[0]).toMatchObject({ from: "14:00", to: "23:59", fixed: true });
    expect(d2.stops[0].acts[0].ref).toBe(stored.index[wienRest].key);
    expect(d2.stops[0].acts[1].ref).toBeUndefined(); // Passau's Dom on a Wien day
    expect(d3.stops[0].acts[0].ref).toBeUndefined(); // Wien's place on the Dürnstein day
    expect(d4.stops[0].acts[0].ref).toBeUndefined(); // sea day
    expect(r.issues.stop_mismatch).toBe(3);
    expect(r.issues.port_window_missing).toBe(0);
    expect(r.plan.days[4].stops[0]).toMatchObject({ from: "08:00", fixed: true });
  });

  it("counts a row whose place the model left out", () => {
    const r = run([day(1, "Passau", []), day(2, "Linz", []), day(3, "Dürnstein", []), day(4, "An Bord", []), day(5, "Passau", [])]);
    expect(r.ok && r.issues.port_window_missing).toBe(1);
  });

  it("the row times count as times of the user (a window with them stays fixed)", () => {
    expect([...inputTimes(stored)].sort()).toEqual(["07:00", "08:00", "12:00", "14:00", "16:00", "23:59"]);
  });

  it("a plan without trip.stops is assembled as before (no stop issues)", () => {
    const plain = emptyStored();
    const r = assemblePlan({ llm: llm(Array.from({ length: 5 }, (_, i) => day(i + 1, "Passau", [{ kind: "see", text: "x", ref: "p1" }]))), stored: plain, header: { ...header(5), lengthDays: 5, timing: { kind: "none" } }, digest: {}, locale: "de" });
    expect(r.ok && r.issues.stop_mismatch).toBe(0);
    expect(r.ok && r.plan.days[3].stops[0].acts[0].ref).toBe("node/1");
  });
});

describe("stop-ref guard without resolved stops", () => {
  it("rows the code could not resolve (no `at`) leave the day a destination day, sea rows still block", () => {
    const s = emptyStored();
    s.llm.trip.stops = [{ day: 1, place: "Wien" }, { day: 2, sea: true }];
    const ctx = stopRefCtx(s)!;
    expect(ctx.destDays.has(1)).toBe(true);
    expect(ctx.seaOnly.has(2)).toBe(true);
    expect(refAllowed(s.index.p1.key, 1, ctx)).toBe(true);
    expect(refAllowed(s.index.p1.key, 2, ctx)).toBe(false);
  });
});
