/**
 * Port-places evals on recorded data (docs/specs/port-places.md section 9): recorded geocoding and Overpass answers
 * around the cruise stops, the real code from geocoding to the plan input and both guards. No network, no model.
 * The Sonnet calls (generate with stops, the failure replay, the patch) are recorded by `npm run evals:live` with
 * EVAL_TASK=stops,stopsfail,portpatch; their checks (`stop-checks.ts`) run here when a recording exists, and on a
 * hand-made synthetic plan always.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { LlmPatch, LlmPlan, PurposeTags } from "@/lib/domain/plan";
import { canonicalJson, planInputHash } from "@/lib/plan/hash";
import { assemblePlan } from "@/lib/plan/assemble";
import { applyPatch } from "@/lib/plan/patch";
import { guardPatch } from "@/lib/plan/patch-guard";
import { extendInputWithStops, stopPointsOf, stopRows, stopsToRetry } from "@/lib/plan/stops-input";
import { patchNotice } from "@/lib/plan/stops-notice";
import { DESTINATION_KM } from "@/lib/plan/stops-resolve";
import { haversineKm } from "@/lib/facts/places";
import { MODEL_PLAN } from "@/lib/domain/ai";
import { FIXTURES, FIXTURE_IDS, buildEvalInput, evalTrip, type FixtureId } from "./build-input";
import { EVAL_TODAY } from "./build-input";
import { evalStopContext, evaluatePortPatch, evaluateStopGenerate, notesStops, readStopRecording, scheduleStops, STOP_NAMES, withCountryHints } from "./port-places";
import { readRecording } from "./recorded";
import { evaluateGenerate, RECORDED_GENERATED_AT } from "./evaluate";
import { rawStopMismatches, stopFailureChecks, stopGenerateChecks, mealWindows } from "./stop-checks";
import { formatResults } from "./evaluate";

const rec = readStopRecording();
const failed = <T extends { ok: boolean }>(rs: T[]) => rs.filter((r) => !r.ok);
const tags = readRecording<PurposeTags>("cruise", "tags")?.output ?? null;

describe("golf, Würzburg and the cruise without stops keep their input byte for byte", () => {
  for (const id of FIXTURE_IDS) {
    const gen = readRecording<LlmPlan>(id, "generate");
    it.runIf(!!gen)(`${id}: the recorded input hash still verifies under the prompt version it was recorded with`, () => {
      const tg = readRecording<PurposeTags>(id, "tags")?.output ?? null;
      const built = buildEvalInput(id as FixtureId, tg);
      expect(built.stored.llm.trip).not.toHaveProperty("stops");
      expect(built.stored.llm).not.toHaveProperty("stopPlaces");
      expect(built.stored).not.toHaveProperty("stopPoints");
      expect(planInputHash(built.stored.llm, gen!.promptVersion)).toBe(gen!.inputHash);
    });
  }
});

describe.runIf(!!rec)("cruise stops: geocoding (recorded Open-Meteo)", () => {
  it("every stop resolves to a populated place in Austria; Passau is the destination on days 1 and 5", async () => {
    const ctx = (await evalStopContext("confirmed"))!;
    const stops = ctx.resolved.filter((r) => r.role === "stop");
    expect(stops.map((s) => [s.id, s.name, s.days])).toEqual([["s1", "Wien", [2]], ["s2", "Dürnstein", [3]], ["s3", "Melk", [3]], ["s4", "Linz", [4]]]);
    for (const s of stops) expect(s.status, s.name).toBe("ok");
    const dest = ctx.resolved.find((r) => r.role === "destination")!;
    expect(dest.days).toEqual([1, 5]);
    const a = FIXTURES.cruise.trip.anchor;
    expect(haversineKm(a, dest.point!)).toBeLessThan(DESTINATION_KM);
    for (const name of STOP_NAMES.filter((n) => n !== "Passau")) {
      const hit = rec!.lookups[name];
      expect(hit?.point, `${name} recorded`).toBeDefined();
    }
  });
});

describe.runIf(!!rec)("cruise stops: both variants give the same schedule", () => {
  it("rows from the notes and from the confirmed stops are equal, apart from the note wording", async () => {
    const notes = (await evalStopContext("notes"))!;
    const confirmed = (await evalStopContext("confirmed"))!;
    const strip = (rows: { note?: string }[]) => rows.map(({ note: _note, ...r }) => (void _note, r));
    const a = buildEvalInput("cruise", tags, undefined, notes).stored.llm.trip.stops!;
    const b = buildEvalInput("cruise", tags, undefined, confirmed).stored.llm.trip.stops!;
    expect(strip(a)).toEqual(strip(b));
    expect(a.map((r) => r.at)).toEqual(["dest", "s1", "s2", "s3", "s4", "dest"]);
    // The notes variant keeps the typed notes, the confirmed variant has none (rows come from trip.stops).
    expect(buildEvalInput("cruise", tags, undefined, notes).stored.llm.trip.notes).toContain("Schiff");
    expect(buildEvalInput("cruise", tags, undefined, confirmed).stored.llm.trip.notes).toBeUndefined();
    expect(scheduleStops(FIXTURES.cruise.fixedSchedule!, FIXTURES.cruise.trip.startDate)[5]).toMatchObject({ day: 5, place: "Passau", note: "Ankunft morgens" });
  });
});

describe("cruise stops: the notes variant comes from the parser (0 tokens)", () => {
  it("the parser reads scheduleNotes() into exactly the confirmed rows, apart from cc (the parser sets none)", () => {
    const derived = notesStops(evalTrip("cruise"));
    const confirmed = scheduleStops(FIXTURES.cruise.fixedSchedule!, FIXTURES.cruise.trip.startDate);
    expect(derived).toEqual(confirmed.map(({ cc: _cc, ...r }) => (void _cc, r)));
    expect(withCountryHints(derived, confirmed)).toEqual(confirmed);
  });

  it("gives no rows when the parser cannot read the notes (production would call Haiku)", () => {
    expect(notesStops({ ...evalTrip("cruise"), notes: "Am 19.12. legen wir am späten Nachmittag gegen 16 Uhr in Passau ab" })).toEqual([]);
  });
});

describe.runIf(!!rec)("cruise stops: lookups (recorded Overpass) and the plan input", () => {
  it("restaurants and family_activities + general around each stop; the stop places ride in the input", async () => {
    const ctx = (await evalStopContext("confirmed"))!;
    const looked = ctx.facts.filter((f) => f.stop.role === "stop");
    for (const f of looked) {
      expect(f.places.map((g) => g.interest), f.stop.name).toEqual(["family_activities", "general"]);
      expect(f.restaurants?.status, `${f.stop.name} restaurants`).toMatch(/ok|empty/);
    }
    const built = buildEvalInput("cruise", tags, undefined, ctx);
    const sp = built.stored.llm.stopPlaces!;
    expect(sp.map((p) => p.id)).toEqual(["s1", "s2", "s3", "s4"]);
    expect(sp.every((p) => !p.s)).toBe(true);
    for (const p of sp) expect(p.restaurants?.list.length ?? 0).toBeLessThanOrEqual(6);
    expect(sp.find((p) => p.id === "s1")!.restaurants!.list.length).toBeGreaterThan(0);
    const ids = [...sp.flatMap((p) => (p.places ?? []).map((x) => x.id)), ...built.stored.llm.places.map((p) => p.id)];
    expect(new Set(ids).size).toBe(ids.length); // ids are unique across destination and stops
    expect(Object.keys(built.stored.stopPoints!)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("input size before and after (tokens at ~3.5 characters each; spec estimate +120 schedule, +4 x 270 places)", async () => {
    const ctx = (await evalStopContext("confirmed"))!;
    const before = canonicalJson(buildEvalInput("cruise", tags).stored.llm).length;
    const after = canonicalJson(buildEvalInput("cruise", tags, undefined, ctx).stored.llm).length;
    const tokens = Math.round((after - before) / 3.5);
    console.log(`[port-places] cruise input: ${before} -> ${after} characters, about +${tokens} tokens (spec: about +1200)`);
    expect(after).toBeGreaterThan(before);
    expect(tokens).toBeLessThan(3500);
  });

  it("the failure case: Dürnstein's lookups as error give an input that says so, and Generate would not be blocked", async () => {
    const ctx = (await evalStopContext("confirmed", { failing: ["Dürnstein"] }))!;
    const built = buildEvalInput("cruise", tags, undefined, ctx);
    const dur = built.stored.llm.stopPlaces!.find((p) => p.name === "Dürnstein")!;
    expect(dur.s).toBe("error");
    expect(dur.places).toBeUndefined();
    expect(built.stored.llm.stopPlaces!.filter((p) => p.s)).toHaveLength(1);
  });
});

describe.runIf(!!rec)("port patch on the plan-7 cruise base (recorded generation, no trip.stops)", () => {
  const baseRec = readRecording<LlmPlan>("cruise", "generate");
  it.runIf(!!baseRec)("the input is upgraded, the stop lookups land in the index, days 2-4 can use them", async () => {
    const g = evaluateGenerate("cruise", tags, baseRec!.output, { recordedHash: baseRec!.inputHash, recordedVersion: baseRec!.promptVersion });
    const ctx = (await evalStopContext("confirmed"))!;
    const upgraded = extendInputWithStops(g.built.stored, {
      rows: stopRows(ctx.stops, ctx.resolved),
      points: stopPointsOf(ctx.resolved),
      facts: ctx.facts,
      lang: "de",
      cuisine: g.built.stored.llm.restaurants?.ask,
      countryCode: "DE",
    });
    expect(upgraded.llm.trip.stops).toHaveLength(6);
    expect(upgraded.llm.stopPlaces).toHaveLength(4);
    for (const id of Object.keys(g.built.stored.index)) expect(upgraded.index[id]).toEqual(g.built.stored.index[id]); // old refs stay valid
    expect(stopsToRetry(upgraded, [])).toEqual([]);
    expect(Object.keys(upgraded.index).filter((k) => upgraded.index[k].stop)).not.toHaveLength(0);
  });

  it.runIf(!!baseRec)("negative patch: the same request on a trip without stops gives stops_unknown, never a bare noChange", () => {
    const g = evaluateGenerate("cruise", tags, baseRec!.output, { recordedHash: baseRec!.inputHash, recordedVersion: baseRec!.promptVersion });
    const trip = evalTrip("cruise");
    const patch: LlmPatch = { reply: "Ich habe konkrete Restaurants ergänzt.", days: [] };
    const applied = applyPatch({ base: g.plan!, patch, stored: g.built.stored, scope: [] });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const guarded = guardPatch({ base: g.plan!, next: applied.plan, feedback: { chips: [], days: [], text: "konkrete Restaurantvorschläge für die Tage an Land in anderen Städten" }, index: g.built.stored.index });
    expect(guarded.changedDays).toEqual([]);
    const notice = patchNotice({
      stored: g.built.stored,
      scopeDays: [],
      tripHasStops: false,
      base: g.plan!,
      destinationNames: [trip.destination.name, trip.destination.kind === "freetext" ? "" : trip.destination.placeName],
    });
    expect(notice).toEqual({ code: "stops_unknown", places: [] });
    expect(MODEL_PLAN).toBeTruthy();
    expect(RECORDED_GENERATED_AT).toBeTruthy();
    expect(EVAL_TODAY).toBeTruthy();
  });
});

describe.runIf(!!rec)("stop checks on a synthetic model answer (hand-made, not a model recording)", () => {
  /** A plan that does what rule 17 asks: port windows, the stop's own meals, generic text elsewhere. */
  async function synthetic(over: { wrongRef?: boolean; noWindows?: boolean } = {}) {
    const ctx = (await evalStopContext("confirmed"))!;
    const built = buildEvalInput("cruise", tags, undefined, ctx);
    const sp = built.stored.llm.stopPlaces!;
    const rest = (id: string) => sp.find((p) => p.id === id)!.restaurants!.list;
    const day = (n: number, place: string, acts: LlmPlan["days"][number]["stops"][number]["acts"], extra: object = {}) => ({ n, title: `Tag ${n}`, stops: [{ place, ...extra, acts }] });
    const meal = (id: string) => ({ kind: "food" as const, text: "Abendessen", ref: rest(id)[0]?.id, alts: rest(id).slice(1, 3).map((x) => x.id) });
    const llm: LlmPlan = {
      summary: "Donaukreuzfahrt.",
      days: [
        day(1, "Passau", [{ kind: "see", text: "Bummel" }]),
        day(2, "Wien", [{ kind: "see", text: "Altstadt" }, meal("s1")]),
        { n: 3, title: "Tag 3", stops: [{ place: "Dürnstein", acts: [{ kind: "see" as const, text: "Spaziergang" }] }, { place: "Melk", acts: [{ kind: "see" as const, text: "Stift", at: "16:00" }, meal("s3")] }] },
        day(4, "Linz", [{ kind: "food", text: "Mittagessen", ref: rest("s4")[0]?.id }]),
        day(5, "Passau", [{ kind: "see", text: "Ausschiffung" }]),
      ],
      notes: [],
      open: [],
      packing: [],
    };
    if (over.wrongRef) llm.days[2].stops[0].acts[0].ref = sp[0].places?.[0]?.id ?? rest("s1")[0].id; // a Wien place on the Dürnstein day
    if (over.noWindows) for (const d of llm.days) for (const s of d.stops) delete (s as { fixed?: boolean }).fixed;
    // The model copies the windows the way rule 5 asks.
    if (!over.noWindows) {
      const rows = built.stored.llm.trip.stops!;
      for (const r of rows) {
        const st = llm.days[r.day - 1]?.stops.find((s) => s.place === r.place);
        if (st && (r.arr || r.dep)) Object.assign(st, { fixed: true, ...(r.arr ? { from: r.arr } : {}), ...(r.dep ? { to: r.dep } : {}) });
      }
    }
    const assembled = assemblePlan({ llm, stored: built.stored, header: { ...built.header, generatedAt: RECORDED_GENERATED_AT, model: MODEL_PLAN }, digest: built.digest, locale: "de" });
    if (!assembled.ok) throw new Error(assembled.reason);
    return { llm, built, assembled };
  }

  it("a plan that follows the rules passes every check", async () => {
    const { llm, built, assembled } = await synthetic();
    const rs = stopGenerateChecks({ llm, plan: assembled.plan, stored: built.stored, issues: assembled.issues });
    expect(failed(rs), formatResults("synthetic", rs)).toEqual([]);
    expect(mealWindows(built.stored).map((w) => [w.day, w.place, w.at])).toEqual([[2, "Wien", "19:00"], [3, "Melk", "19:00"], [4, "Linz", "12:00"]]);
  });

  it("a stop place on the wrong day is reported raw, dropped by the guard, and the stored plan passes", async () => {
    const { llm, built, assembled } = await synthetic({ wrongRef: true });
    expect(rawStopMismatches(llm, built.stored)).not.toHaveLength(0);
    expect(assembled.issues.stop_mismatch).toBeGreaterThan(0);
    const rs = stopGenerateChecks({ llm, plan: assembled.plan, stored: built.stored, issues: assembled.issues });
    expect(failed(rs), formatResults("synthetic wrong ref", rs)).toEqual([]);
  });

  it("windows the model did not copy fail the raw check but are applied by the guard", async () => {
    const { llm, built, assembled } = await synthetic({ noWindows: true });
    const rs = stopGenerateChecks({ llm, plan: assembled.plan, stored: built.stored, issues: assembled.issues });
    expect(failed(rs).every((r) => r.name.startsWith("raw port window"))).toBe(true);
    expect(failed(rs).length).toBeGreaterThan(0);
  });

  it("the failure checks want a note on the failed stop's day", async () => {
    const { built, assembled } = await synthetic();
    const bad = stopFailureChecks(assembled.plan, built.stored, { id: "s2", name: "Dürnstein", day: 3 });
    expect(failed(bad).map((r) => r.name)).toEqual(expect.arrayContaining([expect.stringContaining("could not be checked"), expect.stringContaining("failed stop is marked")]));
  });
});

// Recorded Sonnet output of the stop evals (`npm run evals:live` with EVAL_TASK=stops,stopsnotes,stopsfail,portpatch).
// Each block runs only when its recording exists.
describe.runIf(!!rec)("recorded model output with stops", () => {
  for (const [task, variant, failing] of [["stops", "confirmed", []], ["stopsnotes", "notes", []], ["stopsfail", "confirmed", ["Dürnstein"]]] as const) {
    const r = readRecording<LlmPlan>("cruise", task);
    it.runIf(!!r)(`${task}: the Generate checks pass`, async () => {
      const g = await evaluateStopGenerate(variant, r!.output, { failing });
      expect(failed(g.results), formatResults(`cruise ${task}`, g.results)).toEqual([]);
    });
  }
  const pr = readRecording<LlmPatch>("cruise", "portpatch");
  const base = readRecording<LlmPlan>("cruise", "generate");
  it.runIf(!!pr && !!base)("portpatch: the input is upgraded, one call, days 2-4 gain restaurant refs of their stops", async () => {
    const g = await evaluatePortPatch(base!.output, pr!.output);
    expect(failed(g.results), formatResults("cruise portpatch", g.results)).toEqual([]);
  });
});
