/**
 * Tour order with per-stop time windows (docs/specs/city-tour.md 17.1 [P6], 17.4). Pure.
 *
 * Times are seconds of the tour day: the visit of point i starts at max(arrival, after[i]) (waiting allowed) and must
 * start by before[i]; it lasts dwell[i]. Matrix durations are seconds.
 * - Up to `EXACT_MAX_POINTS`: forward Held–Karp over "earliest leave time" per (visited set, last point), keeping only
 *   on-time states. Earliest is optimal because waiting is allowed (arriving earlier never hurts). Returns the order
 *   with the earliest finish, or null when no order meets every window.
 * - Above, or when no on-time order exists: deterministic local search (2-opt and Or-opt with full evaluation) on
 *   cost = lateness first, then finish time, from the given seeds. Never drops a stop: late stops are reported.
 */
import type { Matrix } from "./order";

export type WindowTiming = {
  /** Tour start, seconds of the day. */
  startSec: number;
  /** Visit length per point index, seconds. */
  dwellSec: readonly number[];
  /** Window per point index, seconds of the day; undefined = none. */
  win: readonly ({ after?: number; before?: number } | undefined)[];
};

const BIG = 1e12;
const EPS = 1e-6;
const MAX_PASSES = 300;

type Frame = { n: number; start?: number; end?: number; round: boolean };

/** Lateness (s) and finish time (s) of a full sequence; null edges count as BIG lateness. */
export function evaluate(m: Matrix, t: WindowTiming, seq: readonly number[], round: boolean): { late: number; finish: number; lateAt: number[] } {
  let time = t.startSec;
  let late = 0;
  const lateAt: number[] = [];
  const last = round ? seq.length - 1 : seq.length;
  for (let i = 0; i < seq.length; i++) {
    const p = seq[i];
    if (i > 0) {
      const d = m[seq[i - 1]][p];
      if (d == null) late += BIG;
      time += d ?? 0;
    }
    if (i === last) break; // round trip: back at the start, no second visit
    const w = t.win[p];
    if (w?.after !== undefined && time < w.after) time = w.after;
    if (w?.before !== undefined && time > w.before + EPS) {
      late += time - w.before;
      lateAt.push(p);
    }
    time += t.dwellSec[p] ?? 0;
  }
  return { late, finish: time, lateAt };
}

const better = (a: { late: number; finish: number }, b: { late: number; finish: number }) =>
  a.late < b.late - EPS || (Math.abs(a.late - b.late) <= EPS && a.finish < b.finish - EPS);

/** Exact earliest-finish order meeting every window, or null (none exists, or `n` too large for the caller). */
export function exactWindowOrder(m: Matrix, t: WindowTiming, opts: { start?: number; end?: number }): number[] | null {
  const n = m.length;
  const round = opts.start !== undefined && opts.end === opts.start;
  const f: Frame = { n, start: opts.start, end: round ? undefined : opts.end, round };
  const full = (1 << n) - 1;
  const leave = new Float64Array((full + 1) * n).fill(Infinity);
  const parent = new Int8Array((full + 1) * n).fill(-1);
  const visit = (arrive: number, p: number): number => {
    const w = t.win[p];
    const begin = w?.after !== undefined ? Math.max(arrive, w.after) : arrive;
    if (w?.before !== undefined && begin > w.before + EPS) return Infinity; // late: not an on-time state
    return begin + (t.dwellSec[p] ?? 0);
  };
  const firsts = f.start !== undefined ? [f.start] : [...Array(n).keys()].filter((i) => i !== f.end);
  for (const s of firsts) leave[(1 << s) * n + s] = visit(t.startSec, s);
  // The fixed end (not a round trip) may only be added last.
  for (let mask = 1; mask <= full; mask++) {
    for (let j = 0; j < n; j++) {
      const cur = leave[mask * n + j];
      if (!(mask & (1 << j)) || !Number.isFinite(cur)) continue;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        if (k === f.end && (mask | (1 << k)) !== full) continue;
        if (round && k === f.start) continue;
        const d = m[j][k];
        if (d == null) continue;
        const next = visit(cur + d, k);
        const idx = (mask | (1 << k)) * n + k;
        if (next < leave[idx] - EPS) {
          leave[idx] = next;
          parent[idx] = j;
        }
      }
    }
  }
  let best = Infinity;
  let last = -1;
  for (let j = 0; j < n; j++) {
    let v = leave[full * n + j];
    if (!Number.isFinite(v)) continue;
    if (f.end !== undefined && j !== f.end) continue;
    if (round) {
      const back = m[j][f.start!];
      if (back == null) continue;
      v += back;
    }
    if (v < best - EPS) {
      best = v;
      last = j;
    }
  }
  if (last < 0) return null;
  const seq: number[] = [];
  let mask = full;
  let at = last;
  while (at >= 0) {
    seq.push(at);
    const p = parent[mask * n + at];
    mask &= ~(1 << at);
    at = p;
  }
  seq.reverse();
  if (round) seq.push(f.start!);
  return seq;
}

/** Local search on (lateness, finish) from the seeds; returns the best sequence found and its late points. */
export function searchWindowOrder(
  m: Matrix,
  t: WindowTiming,
  opts: { start?: number; end?: number },
  seeds: readonly (readonly number[])[],
): { order: number[]; lateAt: number[] } {
  const round = opts.start !== undefined && opts.end === opts.start;
  const lo = opts.start !== undefined ? 1 : 0;
  const tail = round || opts.end !== undefined ? 1 : 0;
  let best: { seq: number[]; late: number; finish: number; lateAt: number[] } | null = null;
  for (const seed of seeds) {
    let seq = [...seed];
    let cur = evaluate(m, t, seq, round);
    const hi = seq.length - 1 - tail;
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let moved = false;
      // 2-opt: reverse seq[i..j].
      for (let i = lo; i < hi && !moved; i++) {
        for (let j = i + 1; j <= hi && !moved; j++) {
          const cand = [...seq.slice(0, i), ...seq.slice(i, j + 1).reverse(), ...seq.slice(j + 1)];
          const e = evaluate(m, t, cand, round);
          if (better(e, cur)) {
            seq = cand;
            cur = e;
            moved = true;
          }
        }
      }
      // Or-opt: move a run of 1–3 points elsewhere in the movable part.
      for (let len = 1; len <= 3 && !moved; len++) {
        for (let i = lo; i + len - 1 <= hi && !moved; i++) {
          const seg = seq.slice(i, i + len);
          const rest = [...seq.slice(0, i), ...seq.slice(i + len)];
          for (let k = lo; k <= hi - len + 1 && !moved; k++) {
            if (k === i) continue;
            const cand = [...rest.slice(0, k), ...seg, ...rest.slice(k)];
            const e = evaluate(m, t, cand, round);
            if (better(e, cur)) {
              seq = cand;
              cur = e;
              moved = true;
            }
          }
        }
      }
      if (!moved) break;
    }
    if (!best || better(cur, best)) best = { seq, ...cur };
  }
  return { order: best!.seq, lateAt: best!.lateAt };
}

/** Seed that visits windowed points by their deadline (earliest `before`, then `after`), the rest by input order. */
export function deadlineSeed(n: number, t: WindowTiming, opts: { start?: number; end?: number }): number[] {
  const round = opts.start !== undefined && opts.end === opts.start;
  const end = round ? undefined : opts.end;
  const key = (i: number) => t.win[i]?.before ?? t.win[i]?.after ?? Infinity;
  const mid = [...Array(n).keys()].filter((i) => i !== opts.start && i !== end).sort((a, b) => key(a) - key(b) || a - b);
  const seq = opts.start !== undefined ? [opts.start, ...mid] : mid;
  if (round) seq.push(opts.start!);
  else if (end !== undefined) seq.push(end);
  return seq;
}
