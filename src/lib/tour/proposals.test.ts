import { describe, expect, it } from "vitest";
import { overProposals, type ProposalInput } from "./proposals";

// 4 places in a line 0–1–2–3, 10 min per step; place 3 is a 30-min detour from everything except 2.
const MIN = 60;
const m = [
  [0, 10, 20, 30],
  [10, 0, 10, 20],
  [20, 10, 0, 10],
  [30, 20, 10, 0],
].map((r) => r.map((x) => x * MIN));

const base: ProposalInput = {
  m,
  keys: ["a", "b", "c", "d"],
  dwell: [30, 30, 30, 30],
  order: [0, 1, 2, 3],
  keep: false,
  totalMin: 150, // 30 legs + 120 dwell
  maxMin: 120,
  dwellDefaultMin: 30,
};

describe("overProposals", () => {
  it("drops one place each, best saving first, and only proposals that save time", () => {
    // Dropping an end place saves its leg (10) + dwell (30); a middle place saves only its dwell.
    expect(overProposals(base)).toEqual([
      { kind: "drop", key: "a", totalMin: 110, approx: true },
      { kind: "drop", key: "d", totalMin: 110, approx: true },
      { kind: "drop", key: "b", totalMin: 120, approx: true },
    ]);
  });

  it("proposes dwell to default and optimize for 'keep'", () => {
    const keep: ProposalInput = { ...base, keep: true, order: [0, 2, 1, 3], dwell: [90, 30, 30, 30], totalMin: 220 };
    // Matrix now: 20+10+20 = 50 min; optimized 30 → saves 20. Dwell 90 → 30 saves 60.
    const out = overProposals({ ...keep, maxMin: 165 });
    expect(out[0]).toEqual({ kind: "dwell", totalMin: 160, approx: true });
    // Dropping "a" saves its 90-min dwell and 20 min of legs; optimize (200) does not fit, so it comes last.
    expect(out.slice(1)).toEqual([
      { kind: "drop", key: "a", totalMin: 110, approx: true },
      { kind: "optimize", totalMin: 200, approx: true },
    ]);
    // With a looser limit both fit: optimize ranks before dwell before drop.
    expect(overProposals({ ...keep, maxMin: 210 }).map((p) => p.kind)).toEqual(["optimize", "dwell", "drop"]);
  });

  it("never drops start or end and keeps at least 2 places", () => {
    const withEnds: ProposalInput = { ...base, start: 0, end: 3, dwell: [0, 30, 30, 0], totalMin: 90 };
    expect(overProposals({ ...withEnds, maxMin: 60 }).map((p) => (p.kind === "drop" ? p.key : p.kind))).toEqual([]);
    // Start + 3 places: drops are offered, never for the start.
    const three: ProposalInput = { ...base, start: 0, dwell: [0, 30, 30, 30], totalMin: 120, maxMin: 60 };
    const drops = overProposals(three).flatMap((p) => (p.kind === "drop" ? [p.key] : []));
    expect(drops.length).toBeGreaterThan(0);
    expect(drops).not.toContain("a");
  });

  it("without a matrix only offers the dwell proposal", () => {
    expect(overProposals({ ...base, m: null, dwell: [60, 30, 30, 30], totalMin: 180 })).toEqual([
      { kind: "dwell", totalMin: 150, approx: true },
    ]);
  });
});
