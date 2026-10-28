/**
 * Live eval runner (spec 7). Real Claude calls, guarded by the cost ledger (evals/.ledger.json) before each call.
 * Run: `npm run evals:live` with optional EVAL_FIXTURE=golf|cruise and EVAL_TASK=tags|generate|patch
 * (comma-separated). Usage goes to the ledger, not to ai_usage. Writes evals/recorded/*.json.
 */
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MODEL_PLAN, MODEL_TAGS, PLAN_PROMPT_VERSION, TAGS_PROMPT_VERSION, type AiCtx, type AiTask, type AiUsageRecord } from "@/lib/domain/ai";
import type { LlmPatch, LlmPlan, PurposeTags } from "@/lib/domain/plan";
import { planInputHash, purposeTagsHash, canonicalJson } from "@/lib/plan/hash";
import { composePlan, patchPlan } from "@/lib/server/ai/compose";
import { tagPurpose } from "@/lib/server/ai/purpose-tags";
import { buildEvalInput, evalPurpose, FIXTURE_IDS, PATCH_FEEDBACK, type FixtureId } from "./build-input";
import { evaluateGenerate, evaluatePatch, evaluateTags, formatResults } from "./evaluate";
import { assertBudget, readLedger, recordSpend } from "./ledger";
import { readRecording, writeRecording, type RecordedTask } from "./recorded";
import { createHash } from "node:crypto";

vi.mock("server-only", () => ({}));

const LIVE = process.env.EVAL_LIVE === "1";
if (LIVE && !process.env.ANTHROPIC_API_KEY && existsSync(".env.local")) process.loadEnvFile(".env.local");

const pick = <T extends string>(env: string | undefined, all: readonly T[]): T[] =>
  env ? (env.split(",").map((s) => s.trim()).filter((s) => (all as readonly string[]).includes(s)) as T[]) : [...all];
const fixtures = pick<FixtureId>(process.env.EVAL_FIXTURE, FIXTURE_IDS);
const tasks = pick<RecordedTask>(process.env.EVAL_TASK, ["tags", "generate", "patch"]);

const usd = (micro: number) => `$${(micro / 1e6).toFixed(4)}`;
const fmtUsage = (u: AiUsageRecord) =>
  `${u.task} ${u.model} ${u.status}${u.errorCode ? `/${u.errorCode}` : ""}: in ${u.inputTokens}, out ${u.outputTokens}, ` +
  `cache write ${u.cacheCreationInputTokens}, cache read ${u.cacheReadInputTokens}, ${usd(u.costMicroUsd)}, ${u.latencyMs} ms`;

function ctxFor(id: FixtureId, task: AiTask, sink: AiUsageRecord[]): AiCtx {
  assertBudget(task); // throws before any call
  return {
    onUsage: async (u) => {
      sink.push(u);
      recordSpend({ fixture: id, task, costMicroUsd: u.costMicroUsd, status: u.status });
      console.log(`[${id}] ${fmtUsage(u)}`);
    },
  };
}

describe.runIf(LIVE)("live evals", () => {
  for (const id of fixtures) {
    it(`${id}: ${tasks.join(", ")}`, async () => {
      expect(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY missing").toBeTruthy();
      const usage: AiUsageRecord[] = [];
      const recordedAt = new Date().toISOString();

      // 1. Purpose tags (Haiku)
      let tags = readRecording<PurposeTags>(id, "tags")?.output ?? null;
      if (tasks.includes("tags")) {
        const purpose = evalPurpose(id, null)!;
        const r = await tagPurpose(purpose, ctxFor(id, "purpose_tags", usage));
        if (r.ok) {
          tags = r.data;
          writeRecording(id, "tags", { promptVersion: TAGS_PROMPT_VERSION, model: MODEL_TAGS, inputHash: purposeTagsHash(purpose), output: r.data, usage: r.usage, recordedAt });
          console.log(formatResults(`[${id}] tags ${canonicalJson(r.data)}`, evaluateTags(id, r.data)));
        } else console.log(`[${id}] tags failed: ${r.error}`);
      }

      // 2. Generation (Sonnet)
      let llmPlan = readRecording<LlmPlan>(id, "generate")?.output ?? null;
      if (tasks.includes("generate")) {
        const built = buildEvalInput(id, tags);
        console.log(`[${id}] input: ${built.stored.llm.places.length} places, ${canonicalJson(built.stored.llm).length} chars`);
        const r = await composePlan(built.stored.llm, ctxFor(id, "plan_generate", usage));
        if (r.ok) {
          llmPlan = r.data;
          writeRecording(id, "generate", { promptVersion: PLAN_PROMPT_VERSION, model: MODEL_PLAN, inputHash: planInputHash(built.stored.llm), output: r.data, usage: r.usage, recordedAt });
          console.log(formatResults(`[${id}] generate`, evaluateGenerate(id, tags, r.data).results));
        } else console.log(`[${id}] generate failed: ${r.error}`);
      }

      // 3. Patch (Sonnet), on the recorded or fresh generation
      if (tasks.includes("patch") && llmPlan) {
        const g = evaluateGenerate(id, tags, llmPlan);
        if (!g.plan) throw new Error("base plan does not assemble");
        const feedback = PATCH_FEEDBACK[id];
        const r = await patchPlan({ llm: g.built.stored.llm, plan: g.plan, index: g.built.stored.index, feedback }, ctxFor(id, "plan_patch", usage));
        if (r.ok) {
          const inputHash = createHash("sha256").update(canonicalJson({ base: planInputHash(g.built.stored.llm), feedback })).digest("hex");
          writeRecording(id, "patch", { promptVersion: PLAN_PROMPT_VERSION, model: MODEL_PLAN, inputHash, output: r.data, usage: r.usage, recordedAt });
          console.log(`[${id}] reply: ${r.data.reply}`);
          console.log(formatResults(`[${id}] patch`, evaluatePatch(id, tags, g.plan, r.data as LlmPatch).results));
        } else console.log(`[${id}] patch failed: ${r.error}`);
      }

      const total = usage.reduce((s, u) => s + u.costMicroUsd, 0);
      console.log(`[${id}] run cost ${usd(total)}; ledger spent ${usd(readLedger().spentMicroUsd)}`);
    });
  }
});
