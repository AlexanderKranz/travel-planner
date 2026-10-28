import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertBudget, effectiveCap, LedgerExceeded, readLedger, recordSpend } from "./ledger";

describe("eval cost ledger", () => {
  it("refuses a call whose reserve would exceed the cap, before calling", () => {
    const path = join(mkdtempSync(join(tmpdir(), "ledger-")), ".ledger.json");
    expect(readLedger(path)).toEqual({ capMicroUsd: 1_000_000, spentMicroUsd: 0, runs: [] });
    recordSpend({ fixture: "golf", task: "plan_generate", costMicroUsd: 860_000 }, path);
    expect(() => assertBudget("plan_patch", path)).not.toThrow(); // 860k + 50k
    expect(() => assertBudget("plan_generate", path)).toThrow(LedgerExceeded); // 860k + 150k
    expect(readLedger(path).runs).toHaveLength(1);
  });

  it("EVAL_BUDGET_USD can only lower the cap", () => {
    expect(effectiveCap(1_000_000, "0.25")).toBe(250_000);
    expect(effectiveCap(1_000_000, "5")).toBe(1_000_000);
    expect(effectiveCap(1_000_000, undefined)).toBe(1_000_000);
    expect(effectiveCap(1_000_000, "abc")).toBe(1_000_000);
  });
});
