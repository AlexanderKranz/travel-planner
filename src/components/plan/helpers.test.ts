import { describe, expect, it } from "vitest";
import {
  asPlanError,
  budgetExhausted,
  budgetPercent,
  daylightRange,
  highlightedDays,
  progressStage,
  range,
  shouldKeepPolling,
  summarizeFeedback,
  toggleIn,
  windowKind,
} from "./helpers";

const budget = (spent: number, cap: number) => ({ spentMicroUsd: spent, capMicroUsd: cap, resetsAt: "x" });

describe("plan helpers", () => {
  it("maps unknown error codes to failed", () => {
    expect(asPlanError("busy")).toBe("busy");
    expect(asPlanError("boom")).toBe("failed");
    expect(asPlanError(undefined)).toBe("failed");
  });
  it("stages progress by elapsed time", () => {
    expect(progressStage(0)).toBe("facts");
    expect(progressStage(10)).toBe("writing");
    expect(progressStage(99)).toBe("writing");
    expect(progressStage(100)).toBe("long");
  });
  it("stops polling after 4 minutes", () => {
    expect(shouldKeepPolling(239_999)).toBe(true);
    expect(shouldKeepPolling(240_000)).toBe(false);
  });
  it("computes the budget percentage", () => {
    expect(budgetPercent(budget(212_000, 500_000))).toBe(42);
    expect(budgetPercent(budget(900_000, 500_000))).toBe(100);
    expect(budgetPercent(budget(0, 0))).toBe(100);
    expect(budgetExhausted(budget(500_000, 500_000))).toBe(true);
    expect(budgetExhausted(budget(1, 500_000))).toBe(false);
  });
  it("toggles with a maximum and keeps order", () => {
    expect(toggleIn([3], 1)).toEqual([1, 3]);
    expect(toggleIn([1, 3], 1)).toEqual([3]);
    expect(toggleIn([1, 2], 3, 2)).toEqual([1, 2]);
    expect(toggleIn(["b"], "a")).toEqual(["a", "b"]);
  });
  it("builds day ranges", () => {
    expect(range(3)).toEqual([1, 2, 3]);
    expect(range(0)).toEqual([]);
  });
  it("classifies time windows", () => {
    expect(windowKind("07:00", "12:00")).toBe("both");
    expect(windowKind("07:00")).toBe("from");
    expect(windowKind(undefined, "12:00")).toBe("to");
    expect(windowKind()).toBeNull();
  });
  it("finds the daylight range", () => {
    expect(
      daylightRange([
        { sunrise: "07:45", dusk: "16:10" },
        { sunrise: "07:40", dusk: null },
        { sunrise: null, dusk: "16:30" },
      ]),
    ).toEqual({ sunrise: "07:40", dusk: "16:30" });
    expect(daylightRange([{ sunrise: null, dusk: null }])).toBeNull();
  });
  it("summarizes feedback of patches and edits", () => {
    expect(summarizeFeedback({ feedback: null })).toEqual({ type: "none" });
    expect(summarizeFeedback({ feedback: { kind: "swap_days", a: 1, b: 3 } })).toEqual({ type: "swap_days", a: 1, b: 3 });
    expect(summarizeFeedback({ feedback: { kind: "set_best", n: null } })).toEqual({ type: "set_best", n: null });
    expect(summarizeFeedback({ feedback: { chips: ["more_rest"], days: [2] } })).toEqual({
      type: "chips",
      chips: ["more_rest"],
      days: [2],
      text: undefined,
    });
  });
  it("highlights days only for patch and edit versions", () => {
    expect(highlightedDays({ kind: "patch", changedDays: [2] })).toEqual([2]);
    expect(highlightedDays({ kind: "generate", changedDays: [1] })).toEqual([]);
    expect(highlightedDays(undefined)).toEqual([]);
  });
});
