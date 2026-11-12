/**
 * Proposals when a tour is over its limit (docs/specs/city-tour.md section 7 [T10]). Pure, 0 API calls: savings come
 * from the cached duration matrix, so every proposal is labelled approximate ("ca."). Nothing is applied by itself.
 *
 * New total = current total − estimated saving (the legs not touched keep their real Directions times). Savings:
 * - drop: each place tried alone (start and end are never dropped, at least 2 places stay); re-ordered with
 *   `orderTour` unless "keep";
 * - dwell: every place above the tour default set to the default (no matrix needed);
 * - optimize: only when "keep" is set.
 * Only proposals that save time are returned, at most 3: those that fit the limit first, then optimize, dwell, drop,
 * then by saving (best first), then by tour position.
 */
import { orderTour, pathSeconds, type Matrix } from "./order";

export type TourProposal =
  | { kind: "optimize"; totalMin: number; approx: true }
  | { kind: "dwell"; totalMin: number; approx: true }
  | { kind: "drop"; key: string; totalMin: number; approx: true };

export const MAX_PROPOSALS = 3;

export type ProposalInput = {
  /** Duration matrix in seconds by point index; null when none is cached (then only the dwell proposal). */
  m: Matrix | null;
  keys: readonly string[];
  /** Dwell minutes by point index (start and end 0). */
  dwell: readonly number[];
  start?: number;
  end?: number;
  /** Current order of point indices (round trip ends with the start again). */
  order: readonly number[];
  keep: boolean;
  totalMin: number;
  maxMin: number;
  dwellDefaultMin: number;
};

/** Leg minutes as stored (each leg rounded) summed over a sequence. */
function matrixMin(m: Matrix, seq: readonly number[]): number | null {
  let s = 0;
  for (let i = 0; i + 1 < seq.length; i++) {
    const d = pathSeconds(m, [seq[i], seq[i + 1]]);
    if (d === null) return null;
    s += Math.round(d / 60);
  }
  return s;
}

function orderWithout(a: ProposalInput, m: Matrix, drop: number): number[] | null {
  if (a.keep) return a.order.filter((i) => i !== drop);
  const keepIdx = a.keys.map((_, i) => i).filter((i) => i !== drop);
  const sub = keepIdx.map((i) => keepIdx.map((j) => m[i][j]));
  const at = (i?: number) => (i === undefined ? undefined : keepIdx.indexOf(i));
  const r = orderTour(sub, { start: at(a.start), end: at(a.end) });
  return "order" in r ? r.order.map((i) => keepIdx[i]) : null;
}

type Scored = { p: TourProposal; saving: number; rank: number; pos: number };

export function overProposals(a: ProposalInput): TourProposal[] {
  const out: Scored[] = [];
  const add = (p: TourProposal, saving: number, rank: number, pos = 0) => {
    if (saving > 0) out.push({ p: { ...p, totalMin: Math.max(0, a.totalMin - saving) }, saving, rank, pos });
  };
  const places = [...new Set(a.order)].filter((i) => i !== a.start && i !== a.end);

  const dwellSaving = places.reduce((s, i) => s + Math.max(0, a.dwell[i] - a.dwellDefaultMin), 0);
  add({ kind: "dwell", totalMin: 0, approx: true }, dwellSaving, 1);

  const m = a.m;
  const now = m ? matrixMin(m, a.order) : null;
  if (m && now !== null) {
    if (a.keep) {
      const r = orderTour(m, { start: a.start, end: a.end });
      const t = "order" in r ? matrixMin(m, r.order) : null;
      if (t !== null) add({ kind: "optimize", totalMin: 0, approx: true }, now - t, 0);
    }
    if (places.length > 2) {
      places.forEach((p, pos) => {
        const seq = orderWithout(a, m, p);
        const t = seq ? matrixMin(m, seq) : null;
        if (t !== null) add({ kind: "drop", key: a.keys[p], totalMin: 0, approx: true }, now - t + a.dwell[p], 2, pos);
      });
    }
  }

  const fits = (s: Scored) => (s.p.totalMin <= a.maxMin ? 0 : 1);
  return out
    .sort((x, y) => fits(x) - fits(y) || x.rank - y.rank || y.saving - x.saving || x.pos - y.pos)
    .slice(0, MAX_PROPOSALS)
    .map((s) => s.p);
}
