/** Cost ledger for live evals (spec 7): refuses a call before it can exceed the cap. Gitignored file. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AiTask } from "@/lib/domain/ai";

export const LEDGER_PATH = join(dirname(fileURLToPath(import.meta.url)), ".ledger.json");
export const DEFAULT_CAP_MICRO_USD = 1_000_000;
/** Reserve per task: the worst case we accept before the call (spec 7). */
export const RESERVE_MICRO_USD: Record<AiTask, number> = { purpose_tags: 2_000, plan_generate: 150_000, plan_patch: 50_000 };

export type LedgerRun = { at: string; fixture: string; task: AiTask; costMicroUsd: number; status?: string };
export type Ledger = { capMicroUsd: number; spentMicroUsd: number; runs: LedgerRun[] };

/** EVAL_BUDGET_USD may only lower the cap. */
export function effectiveCap(ledgerCap: number, envUsd = process.env.EVAL_BUDGET_USD): number {
  const env = envUsd ? Math.round(Number(envUsd) * 1_000_000) : NaN;
  return Number.isFinite(env) && env >= 0 ? Math.min(ledgerCap, env) : ledgerCap;
}

export function readLedger(path = LEDGER_PATH): Ledger {
  if (!existsSync(path)) return { capMicroUsd: DEFAULT_CAP_MICRO_USD, spentMicroUsd: 0, runs: [] };
  const l = JSON.parse(readFileSync(path, "utf8")) as Ledger;
  return { capMicroUsd: Math.min(l.capMicroUsd ?? DEFAULT_CAP_MICRO_USD, DEFAULT_CAP_MICRO_USD), spentMicroUsd: l.spentMicroUsd ?? 0, runs: l.runs ?? [] };
}

export class LedgerExceeded extends Error {}

/** Throws (no call) when spent + reserve would exceed the cap. */
export function assertBudget(task: AiTask, path = LEDGER_PATH): void {
  const l = readLedger(path);
  const cap = effectiveCap(l.capMicroUsd);
  const reserve = RESERVE_MICRO_USD[task];
  if (l.spentMicroUsd + reserve > cap) {
    throw new LedgerExceeded(`ledger: spent ${l.spentMicroUsd} + reserve ${reserve} > cap ${cap} micro-USD; no call made`);
  }
}

/** Adds the actual cost of a finished call (also on failure). */
export function recordSpend(run: Omit<LedgerRun, "at">, path = LEDGER_PATH): Ledger {
  const l = readLedger(path);
  l.spentMicroUsd += run.costMicroUsd;
  l.runs.push({ at: new Date().toISOString(), ...run });
  writeFileSync(path, JSON.stringify(l, null, 2) + "\n");
  return l;
}
