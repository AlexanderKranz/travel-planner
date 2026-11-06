/**
 * Live recording of the addendum-1 purpose-tag cases (Haiku). Real calls, guarded by the cost ledger.
 * Run: `npm run evals:tags-cases`. Writes evals/recorded/tags-cases.json (raw wire output per case), which
 * evals/tags-cases.test.ts replays through normalizeTags and the case checks.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MODEL_TAGS, TAGS_PROMPT_VERSION, type AiUsageRecord } from "@/lib/domain/ai";
import { purposeTagsHash } from "@/lib/plan/hash";
import { callStructured } from "@/lib/server/ai/client";
import { normalizeTags, tagsRequest } from "@/lib/server/ai/purpose-tags";
import { formatResults } from "./evaluate";
import { assertBudget, recordSpend } from "./ledger";
import { RECORDED_DIR } from "./recorded";
import { TAGS_CASES, casePurpose } from "./tags-cases";

vi.mock("server-only", () => ({}));

const LIVE = process.env.EVAL_LIVE === "1";
const ENV_FILE = process.env.EVAL_ENV_FILE || ".env.local";
if (LIVE && !process.env.ANTHROPIC_API_KEY && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

describe.runIf(LIVE)("live purpose tag cases", () => {
  it("records the cases", async () => {
    expect(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY missing").toBeTruthy();
    const cases: unknown[] = [];
    let total = 0;
    for (const c of TAGS_CASES) {
      assertBudget("purpose_tags"); // throws before any call
      const p = casePurpose(c);
      let usage: AiUsageRecord | undefined;
      const r = await callStructured(tagsRequest(p), {
        onUsage: async (u) => {
          usage = u;
          total += u.costMicroUsd;
          recordSpend({ fixture: `tags-case:${c.id}`, task: "purpose_tags", costMicroUsd: u.costMicroUsd, status: u.status });
        },
      });
      const u = usage;
      console.log(`${c.id}: ${r.ok ? JSON.stringify(normalizeTags(r.data)) : r.error}${u ? ` (in ${u.inputTokens}, out ${u.outputTokens}, cache read ${u.cacheReadInputTokens}, write ${u.cacheCreationInputTokens}, $${(u.costMicroUsd / 1e6).toFixed(5)})` : ""}`);
      if (r.ok) {
        console.log(formatResults(`  ${c.id}`, c.check(normalizeTags(r.data))));
        cases.push({ id: c.id, hash: purposeTagsHash(p), wire: r.data, usage: r.usage });
      }
    }
    console.log(`total $${(total / 1e6).toFixed(5)}`);
    writeFileSync(
      join(RECORDED_DIR, "tags-cases.json"),
      JSON.stringify({ promptVersion: TAGS_PROMPT_VERSION, model: MODEL_TAGS, recordedAt: new Date().toISOString(), cases }, null, 2) + "\n",
    );
  });
});
