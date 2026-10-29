/**
 * Demo example plan (scripts/demo/example-plan.json): the recorded golf generation, assembled by the real
 * pipeline code, no LLM call. The JSON is committed so `npm run demo:reset` needs no TypeScript path aliases.
 * This test fails when it drifts from the recording; regenerate with
 * `UPDATE_DEMO_SEED=1 npx vitest run evals/demo-seed.test.ts`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Plan, type LlmPlan } from "@/lib/domain/plan";
import { planInputHash } from "@/lib/plan/hash";
import { evaluateGenerate } from "./evaluate";
import { readRecording } from "./recorded";

vi.mock("server-only", () => ({}));

const FILE =resolve(__dirname, "../scripts/demo/example-plan.json");

function build() {
  const rec = readRecording<LlmPlan>("golf", "generate")!;
  const g = evaluateGenerate("golf", null, rec.output, { recordedHash: rec.inputHash });
  if (!g.plan) throw new Error("assemble failed");
  return {
    $comment: "Generated from evals/recorded/golf.generate.json by evals/demo-seed.test.ts. Do not edit by hand.",
    fixture: "golf",
    model: rec.model,
    inputHash: planInputHash(g.built.stored.llm),
    plan: g.plan,
    input: g.built.stored,
  };
}

describe("demo example plan", () => {
  it("is in sync with the recorded golf generation and is a valid plan", () => {
    const fresh = build();
    if (process.env.UPDATE_DEMO_SEED === "1" || !existsSync(FILE)) {
      writeFileSync(FILE, JSON.stringify(fresh, null, 1) + "\n");
    }
    const onDisk = JSON.parse(readFileSync(FILE, "utf8"));
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(fresh)));
    expect(Plan.safeParse(onDisk.plan).success).toBe(true);
    expect(onDisk.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(onDisk.plan).length).toBeLessThan(262144);
    expect(JSON.stringify(onDisk.input).length).toBeLessThan(131072);
  });
});
