import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertBudget, DEFAULT_CAP_MICRO_USD, effectiveCap, LedgerExceeded, readLedger, recordSpend } from "./ledger";

describe("eval cost ledger", () => {
  it("refuses a call whose reserve would exceed the cap, before calling", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ledger-")), ".ledger.json");
    expect(readLedger(path)).toEqual({ capMicroUsd: DEFAULT_CAP_MICRO_USD, spentMicroUsd: 0, runs: [] });
    recordSpend({ fixture: "golf", task: "plan_generate", costMicroUsd: DEFAULT_CAP_MICRO_USD - 140_000 }, path);
    expect(() => assertBudget("plan_patch", path)).not.toThrow(); // cap - 140k + 50k
    expect(() => assertBudget("plan_generate", path)).toThrow(LedgerExceeded); // cap - 140k + 150k
    expect(readLedger(path).runs).toHaveLength(1);
  });

  it("EVAL_BUDGET_USD can only lower the cap", () => {
    expect(effectiveCap(1_000_000, "0.25")).toBe(250_000);
    expect(effectiveCap(1_000_000, "5")).toBe(1_000_000);
    expect(effectiveCap(1_000_000, undefined)).toBe(1_000_000);
    expect(effectiveCap(1_000_000, "abc")).toBe(1_000_000);
  });
});
