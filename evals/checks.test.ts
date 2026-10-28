/**
 * CI evals (spec 7): recorded model responses → assemble/patch → deterministic checks. No network.
 * A changed input hash only warns, so prompt tweaks do not break CI until the recordings are refreshed.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LlmPatch, LlmPlan, PurposeTags } from "@/lib/domain/plan";
import { canonicalJson, planInputHash, purposeTagsHash } from "@/lib/plan/hash";
import { buildEvalInput, evalPurpose, FIXTURE_IDS, PATCH_FEEDBACK } from "./build-input";
import { evaluateGenerate, evaluatePatch, evaluateTags, formatResults } from "./evaluate";
import { readRecording } from "./recorded";
import { familyPlaceChecks, golfPlaceChecks } from "./checks";
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
    if (tags) expect(a.stored.llm.places.length).toBeGreaterThan(0);
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

  it.runIf(!!genRec && !!patchRec)("recorded patch changes only the scoped days", () => {
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
