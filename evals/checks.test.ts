/**
 * CI evals (spec 7): recorded model responses → assemble/patch → deterministic checks. No network.
 * A changed input hash only warns, so prompt tweaks do not break CI until the recordings are refreshed.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LlmPatch, LlmPlan, PurposeTags } from "@/lib/domain/plan";
import { canonicalJson, planInputHash, purposeTagsHash } from "@/lib/plan/hash";
import { buildEvalInput, evalPurpose, FIXTURE_IDS, PATCH_FEEDBACK } from "./build-input";
import { evaluateFamilyPatch, evaluateUncoveredPatch, evaluateGenerate, evaluateNeedPatch, evaluatePatch, evaluateTags, formatResults, type NeedPatchRecording } from "./evaluate";
import { readRecording } from "./recorded";
import { HONEST_WORDING, familyPatchChecks, familyPlaceChecks, golfPlaceChecks, kidsClaimChecks } from "./checks";
import type { Plan } from "@/lib/domain/plan";
import type { PlanInputStored } from "@/lib/plan/input";

vi.mock("server-only", () => ({}));

const failed = (rs: { ok: boolean }[]) => rs.filter((r) => !r.ok);

describe.each(FIXTURE_IDS)("eval %s", (id) => {
  const tagsRec = readRecording<PurposeTags>(id, "tags");
  const genRec = readRecording<LlmPlan>(id, "generate");
  const patchRec = readRecording<LlmPatch>(id, "patch");
  const tags = tagsRec?.output ?? null;

  it("builds a deterministic input without names or birthdates", () => {
    const a = buildEvalInput(id, tags);
    const b = buildEvalInput(id, tags);
    expect(planInputHash(a.stored.llm)).toBe(planInputHash(b.stored.llm));
    const json = canonicalJson(a.stored.llm);
    expect(json).not.toMatch(/birth|fetchedAt|generatedAt/i);
    // Würzburg has no recorded interest places; its places are activity places and restaurants.
    if (tags) expect(a.stored.llm.places.length + (a.stored.llm.activities?.places.length ?? 0)).toBeGreaterThan(0);
    if (tags && id === "wuerzburg") expect(a.stored.llm.restaurants?.list.length).toBeGreaterThan(0);
    expect(a.stored.llm.places.length).toBeLessThanOrEqual(40);
  });

  it.runIf(!!tagsRec)("recorded tags pass the checks", () => {
    const hash = purposeTagsHash(evalPurpose(id, null)!);
    if (tagsRec!.inputHash !== hash) console.warn(`[${id}] tags recording is from another prompt/input version`);
    const rs = evaluateTags(id, tagsRec!.output);
    expect(failed(rs), formatResults(`${id} tags`, rs)).toEqual([]);
  });

  it.runIf(!!genRec)("recorded generation passes the checks", () => {
    const g = evaluateGenerate(id, tags, genRec!.output, { recordedHash: genRec!.inputHash });
    if (genRec!.inputHash !== planInputHash(g.built.stored.llm)) console.warn(`[${id}] generate recording is from another prompt/input version`);
    expect(failed(g.results), formatResults(`${id} generate`, g.results)).toEqual([]);
  });

  const baseRec = readRecording<LlmPlan>(id, "needbase");
  it.runIf(id === "wuerzburg" && !!baseRec && !!patchRec)("recorded needPlaces patch loads escape rooms and patches day 1", () => {
    const p = evaluateNeedPatch(id, tags, baseRec!.output, patchRec!.output as unknown as NeedPatchRecording);
    expect(failed(p.results), formatResults(`${id} needPlaces patch`, p.results)).toEqual([]);
  });

  const familyRec = readRecording<NeedPatchRecording>(id, "familypatch");
  it.runIf(id === "cruise" && !!genRec && !!familyRec)("recorded family patch (addendum 1): indoor playground ref or honest wording", () => {
    const p = evaluateFamilyPatch(tags, genRec!.output, familyRec!.output);
    expect(failed(p.results), formatResults(`${id} family patch`, p.results)).toEqual([]);
  });

  const uncoveredRec = readRecording<LlmPatch>(id, "uncoveredpatch");
  it.runIf(id === "cruise" && !!genRec && !!uncoveredRec)("recorded uncovered patch (addendum A3): kept as an idea, honest wording", () => {
    const p = evaluateUncoveredPatch(tags, genRec!.output, uncoveredRec!.output);
    expect(failed(p.results), formatResults(`${id} uncovered patch`, p.results)).toEqual([]);
  });

  it.runIf(id !== "wuerzburg" && !!genRec && !!patchRec)("recorded patch changes only the scoped days", () => {
    const g = evaluateGenerate(id, tags, genRec!.output, { recordedHash: genRec!.inputHash });
    const feedback = PATCH_FEEDBACK[id];
    const hash = createHash("sha256").update(canonicalJson({ base: planInputHash(g.built.stored.llm), feedback })).digest("hex");
    if (patchRec!.inputHash !== hash) console.warn(`[${id}] patch recording is from another prompt/input version`);
    const p = evaluatePatch(id, tags, g.plan!, patchRec!.output, { recordedHash: genRec!.inputHash });
    expect(failed(p.results), formatResults(`${id} patch`, p.results)).toEqual([]);
  });
});

describe("concrete-place checks", () => {
  const place = (category: string) => ({ name: "X", category, lat: 0, lon: 0, distanceKm: 1, osmUrl: "https://www.openstreetmap.org/way/1", source: "osm" as const, fetchedAt: "f" });
  const planWith = (acts: { kind: string; text: string; ref?: string; alts?: string[] }[]) =>
    ({
      days: [{ n: 1, date: null, title: "t", stops: [{ place: "p", acts }] }],
      places: { "way/1": place("leisure=golf_course"), "way/2": place("tourism=zoo"), "way/3": place("tourism=attraction") },
    }) as unknown as Plan;
  const stored = {
    llm: { places: [{ id: "p1", i: "golf" }, { id: "p2", i: "family_activities" }, { id: "p3", i: "general" }] },
    index: { p1: { key: "way/1" }, p2: { key: "way/2" }, p3: { key: "way/3" } },
  } as unknown as PlanInputStored;

  it("golf: generic or non-golf sport activities fail", () => {
    expect(failed(golfPlaceChecks(planWith([{ kind: "sport", text: "18 Loch", ref: "way/1", alts: ["way/1"] }])))).toEqual([]);
    expect(failed(golfPlaceChecks(planWith([{ kind: "sport", text: "Erste Runde auf einem Platz im Südwesten" }])))).toHaveLength(1);
    expect(failed(golfPlaceChecks(planWith([{ kind: "sport", text: "x", ref: "way/1", alts: ["way/3"] }])))).toHaveLength(1);
  });

  it("family: a zoo text without (family) ref fails; a ref to a family place passes", () => {
    expect(failed(familyPlaceChecks(planWith([{ kind: "do", text: "Tiergarten", ref: "way/2" }]), stored))).toEqual([]);
    expect(failed(familyPlaceChecks(planWith([{ kind: "food", text: "Mittagessen" }]), stored))).toEqual([]);
    for (const acts of [
      [{ kind: "do", text: "Familienfreundlicher Vergnügungspark oder Tiergarten" }],
      [{ kind: "do", text: "Zoo besuchen", ref: "way/3" }],
    ]) {
      expect(familyPlaceChecks(planWith(acts), stored).filter((r) => !r.ok).map((r) => r.name)).toEqual([
        "zoo/park activities name a verified family place (ref)",
      ]);
    }
    const none = { ...stored, llm: { places: [] } } as unknown as PlanInputStored;
    expect(failed(familyPlaceChecks(planWith([]), none))).toHaveLength(1);
  });
});

describe("addendum 1 checks", () => {
  const p = (name: string, category: string) => ({ name, category, lat: 0, lon: 0, distanceKm: 1, osmUrl: "u", source: "osm" as const, fetchedAt: "f" });
  const planWith = (acts: { kind: string; text: string; ref?: string }[], note?: string) =>
    ({ summary: "s", days: [{ n: 1, date: null, title: "Passau", note, stops: [{ place: "p", acts }] }], notes: [], openItems: [], packing: [] }) as unknown as Plan;
  const stored = {
    llm: { places: [], restaurants: { s: "ok", list: [{ id: "r1", name: "A", km: 1, k: true }, { id: "r2", name: "B", km: 1 }] } },
    index: {
      r1: { key: "node/1", place: p("A", "amenity=restaurant") },
      r2: { key: "node/2", place: p("B", "amenity=restaurant") },
      a1: { key: "node/3", place: p("Kinderland", "leisure=indoor_play") },
      a2: { key: "way/4", place: p("Freibad Haselbach", "leisure=water_park") },
    },
  } as unknown as PlanInputStored;

  it("A4: child-friendly wording only on a kids-tagged restaurant", () => {
    expect(failed(kidsClaimChecks(planWith([{ kind: "food", text: "Abendessen, kinderfreundlich", ref: "node/1" }]), stored))).toEqual([]);
    expect(failed(kidsClaimChecks(planWith([{ kind: "food", text: "Abendessen mit Hochstuhl", ref: "node/2" }]), stored))).toHaveLength(1);
    expect(failed(kidsClaimChecks(planWith([{ kind: "food", text: "Regionale Küche", ref: "node/2" }]), stored))).toEqual([]);
  });

  it("family patch: an indoor play ref or honest wording passes; an open-air pool or the false wording fails", () => {
    const first = { reply: "r", days: [], needPlaces: { types: ["indoor_play" as const] } };
    expect(failed(familyPatchChecks({ first, next: planWith([{ kind: "do", text: "Toben bei Regen", ref: "node/3" }]), stored }))).toEqual([]);
    const honest = planWith([{ kind: "do", text: "Indoorspielplatz (Idee)" }], "Kein Indoorspielplatz in OpenStreetMap in der Nähe gelistet.");
    expect(failed(familyPatchChecks({ first, next: honest, stored }))).toEqual([]);
    const names = (next: Plan) => familyPatchChecks({ first, next, stored }).filter((r) => !r.ok).map((r) => r.name);
    expect(names(planWith([{ kind: "do", text: "Baden", ref: "way/4" }]))).toContain("day 1: no open-air pool ref in December");
    expect(names(planWith([{ kind: "do", text: "Indoorspielplatz" }], "Keine geprüften Orte gefunden"))).toContain("never 'keine geprüften Orte gefunden'");
    expect(names(planWith([{ kind: "do", text: "Indoorspielplatz Kinderwelt" }]))).toEqual([
      "day 1: indoor play/pool ref or honest wording",
      "generic indoor venue only with the honest wording",
    ]);
    expect(HONEST_WORDING.test("Indoorspielplätze sind nicht in den geprüften Quellen enthalten")).toBe(true);
  });
});
