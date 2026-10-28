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
