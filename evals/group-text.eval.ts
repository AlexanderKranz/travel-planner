/**
 * Live recording of the Haiku group-text parse (spec docs/specs/group-text.md [D12]). Real calls, guarded by the cost
 * ledger. Run: `npm run evals:group-text`. Writes evals/recorded/group-text.json (raw wire output per sample text),
 * which src/lib/group-text.test.ts replays through normalizeParse and resolveGroup.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GROUP_PROMPT_VERSION, MODEL_TAGS, type AiUsageRecord } from "@/lib/domain/ai";
import { callStructured } from "@/lib/server/ai/client";
import { groupParseRequest } from "@/lib/server/ai/group-parse";
import { groupTextHash } from "@/lib/plan/hash";
import { assertBudget, recordSpend } from "./ledger";
import { RECORDED_DIR } from "./recorded";

vi.mock("server-only", () => ({}));

const LIVE = process.env.EVAL_LIVE === "1";
if (LIVE && !process.env.ANTHROPIC_API_KEY && existsSync(".env.local")) process.loadEnvFile(".env.local");

export const GROUP_TEXT_SAMPLES = [
  "Wir sind 5 Freunde, alle in meinem Alter",
  "Ich und Ben, ähnliches Alter",
  "2 Erwachsene (45 und 43) und ein Kleinkind, 2 Jahre",
  "Meine Frau und ich, beide Mitte 60, einer von uns sitzt im Rollstuhl",
  "Family: 2 parents around 40 and 3 kids aged 4, 7 and 10",
  "Ich fahre allein",
  "Ben ist 5 Jahre jünger als ich, dazu zwei Kollegen in meinem Alter",
  "Wir spielen alle gern Golf und essen vegetarisch",
  "Seniorengruppe, 12 Personen, ca. 70, zwei mit Rollator",
];

describe.runIf(LIVE)("live group text parse", () => {
  it("records the samples", async () => {
    expect(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY missing").toBeTruthy();
    const recordings: unknown[] = [];
    for (const text of GROUP_TEXT_SAMPLES) {
      assertBudget("group_parse"); // throws before any call
      let usage: AiUsageRecord | undefined;
      const r = await callStructured(groupParseRequest(text), {
        onUsage: async (u) => {
          usage = u;
          recordSpend({ fixture: "group-text", task: "group_parse", costMicroUsd: u.costMicroUsd, status: u.status });
        },
      });
      console.log(`${r.ok ? "ok " : "ERR"} ${text}\n    ${r.ok ? JSON.stringify(r.data) : r.error} ($${((usage?.costMicroUsd ?? 0) / 1e6).toFixed(5)})`);
      if (r.ok) recordings.push({ text, hash: groupTextHash(text), wire: r.data, usage: r.usage });
    }
    writeFileSync(
      join(RECORDED_DIR, "group-text.json"),
      JSON.stringify({ promptVersion: GROUP_PROMPT_VERSION, model: MODEL_TAGS, recordedAt: new Date().toISOString(), samples: recordings }, null, 2) + "\n",
    );
  });
});
