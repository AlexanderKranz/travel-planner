/**
 * Live reproduction of the Copenhagen patch bug (docs/specs/patch-safety.md). Real Sonnet calls, guarded by the cost
 * ledger. Run: `npm run evals:patch-shrink` with optional EVAL_VARIANT=a,b,… (default all) and EVAL_LEDGER=<path>.
 * Writes the raw wire output per variant to evals/recorded/copenhagen.patch-variants.json, which
 * evals/patch-shrink.test.ts replays through normalizePatch, applyPatch and the shrink guard.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PLAN_PROMPT_VERSION, MODEL_PLAN, type AiUsageRecord } from "@/lib/domain/ai";
import type { Plan, PlanFeedback } from "@/lib/domain/plan";
import type { PlanInputStored } from "@/lib/plan/input";
import { callStructured } from "@/lib/server/ai/client";
import { patchRequest } from "@/lib/server/ai/compose";
import { LEDGER_PATH, assertBudget, recordSpend } from "./ledger";
import { RECORDED_DIR } from "./recorded";
import fixture from "../src/lib/plan/__fixtures__/copenhagen.json";

vi.mock("server-only", () => ({}));

const LIVE = process.env.EVAL_LIVE === "1";
const ENV_FILE = process.env.EVAL_ENV_FILE || ".env.local";
if (LIVE && !process.env.ANTHROPIC_API_KEY && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const LEDGER = LEDGER_PATH;

const TEXT = "für tag 1. wir machen Rathausplatz und rådhus, aber machen nicht Verdensur. auch Amagertorv streichen.";
export const PATCH_VARIANTS: Record<string, PlanFeedback> = {
  a: { chips: [], days: [], text: TEXT },
  b: { chips: [], days: [1], text: TEXT },
  c: { chips: [], days: [], text: TEXT.replace("Verdensur", "Jens Olsens Verdensur") },
  d: { chips: [], days: [1], text: TEXT.replace("Verdensur", "Jens Olsens Verdensur") },
};

const OUT = join(RECORDED_DIR, "copenhagen.patch-variants.json");
const wanted = process.env.EVAL_VARIANT ? process.env.EVAL_VARIANT.split(",").map((s) => s.trim()) : Object.keys(PATCH_VARIANTS);

describe.runIf(LIVE)("live patch shrink repro", () => {
  it("records the variants", async () => {
    expect(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY missing").toBeTruthy();
    const input = fixture.input as unknown as PlanInputStored;
    const plan = fixture.plan as unknown as Plan;
    const prev = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as { variants: Record<string, unknown> }) : { variants: {} };
    const variants: Record<string, unknown> = { ...prev.variants };
    for (const id of wanted) {
      const feedback = PATCH_VARIANTS[id];
      if (!feedback) continue;
      assertBudget("plan_patch", LEDGER); // throws before any call
      let usage: AiUsageRecord | undefined;
      const r = await callStructured(patchRequest({ llm: input.llm, plan, index: input.index, feedback }), {
        onUsage: async (u) => {
          usage = u;
          recordSpend({ fixture: `copenhagen-${id}`, task: "plan_patch", costMicroUsd: u.costMicroUsd, status: u.status }, LEDGER);
        },
      });
      console.log(`[${id}] ${usage?.status} in ${usage?.inputTokens} out ${usage?.outputTokens} cw ${usage?.cacheCreationInputTokens} cr ${usage?.cacheReadInputTokens} cost ${usage?.costMicroUsd}`);
      console.log(`[${id}] ${JSON.stringify(r.ok ? r.data : r.error)}`);
      variants[id] = { feedback, output: r.ok ? r.data : null, error: r.ok ? undefined : r.error, usage, recordedAt: new Date().toISOString() };
    }
    writeFileSync(OUT, JSON.stringify({ promptVersion: PLAN_PROMPT_VERSION, model: MODEL_PLAN, variants }, null, 2) + "\n");
  });
});
