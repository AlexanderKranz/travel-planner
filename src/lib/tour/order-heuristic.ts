/**
 * Tour order above the exact limit (docs/specs/city-tour.md 17.1 [P1]): deterministic local search, pure.
 *
 * 1. Seeds: nearest neighbour from every allowed first point (ties: lower index).
 * 2. Each seed is improved by segment reversal (2-opt) and Or-opt (move a run of 1–3 points, also reversed), first
 *    improvement, until no move gains more than `EPS`. Moves are scored in O(1) from forward and backward prefix
 *    sums, so asymmetric matrices are handled exactly.
 *    Plus `RESTARTS` random orders of the free points (seeded PRNG), improved the same way.
 * 3. Iterated local search from the best: `KICKS` double-bridge kicks (seeded PRNG) with a new local search each,
 *    kept when cheaper.
 * Ties by the lexicographically smaller index sequence. Same input, same order. Not guaranteed optimal: callers
 * label it.
 *
 * `null` edges cost `BIG` (finite, so prefix differences stay valid). A best path that still uses one is reported as
 * `null` (the caller decides).
 */
import type { Matrix } from "./order";

const EPS = 1e-6;
const BIG = 1e12;
const MAX_PASSES = 2000;
const KICKS = 200;
const RESTARTS = 30;
/** `quick`: the drop proposals (one order per place, labelled "ca.") trade a little quality for n× fewer steps. */
const QUICK_RESTARTS = 5;
const QUICK_KICKS = 40;

/** mulberry32: deterministic kicks, so the same input gives the same order. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Frame = { n: number; start?: number; end?: number; round: boolean };

function lexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/** Search state over one sequence: edge costs plus forward/backward prefix sums. */
class Path {
  readonly s: number[];
  private readonly f: Float64Array;
  private readonly b: Float64Array;
  cost = 0;

  constructor(
    private readonly m: Matrix,
    seq: readonly number[],
  ) {
    this.s = [...seq];
    this.f = new Float64Array(seq.length);
    this.b = new Float64Array(seq.length);
    this.refresh();
  }

  e(a: number | undefined, z: number | undefined): number {
    if (a === undefined || z === undefined) return 0;
    return this.m[a][z] ?? BIG;
  }

  refresh() {
    const s = this.s;
    for (let k = 1; k < s.length; k++) {
      this.f[k] = this.f[k - 1] + this.e(s[k - 1], s[k]);
      this.b[k] = this.b[k - 1] + this.e(s[k], s[k - 1]);
    }
    this.cost = s.length ? this.f[s.length - 1] : 0;
  }

  /** Forward and reversed inner cost of s[i..j]. */
  fwd(i: number, j: number) {
    return this.f[j] - this.f[i];
  }
  rev(i: number, j: number) {
    return this.b[j] - this.b[i];
  }

  /** Gain of reversing s[i..j]. */
  reversal(i: number, j: number): number {
    const s = this.s;
    const before = this.e(s[i - 1], s[i]) + this.fwd(i, j) + this.e(s[j], s[j + 1]);
    const after = this.e(s[i - 1], s[j]) + this.rev(i, j) + this.e(s[i], s[j + 1]);
    return before - after;
  }

  /** Gain of moving s[i..i+len-1] into the gap after position g (g = -1: before s[0]), optionally reversed. */
  move(i: number, len: number, g: number, reversed: boolean): number {
    const s = this.s;
    const j = i + len - 1;
    const removed = this.e(s[i - 1], s[i]) + this.e(s[j], s[j + 1]) - this.e(s[i - 1], s[j + 1]);
    const u = g >= 0 ? s[g] : undefined;
    const v = s[g + 1];
    const [a, z] = reversed ? [s[j], s[i]] : [s[i], s[j]];
    const inner = reversed ? this.rev(i, j) - this.fwd(i, j) : 0;
    const added = this.e(u, a) + this.e(z, v) - this.e(u, v) + inner;
    return removed - added;
  }

  applyReversal(i: number, j: number) {
    const seg = this.s.slice(i, j + 1).reverse();
    this.s.splice(i, seg.length, ...seg);
    this.refresh();
  }

  applyMove(i: number, len: number, g: number, reversed: boolean) {
    const seg = this.s.slice(i, i + len);
    if (reversed) seg.reverse();
    const u = g >= 0 ? this.s[g] : undefined;
    this.s.splice(i, len);
    const at = u === undefined ? 0 : this.s.indexOf(u) + 1;
    this.s.splice(at, 0, ...seg);
    this.refresh();
  }
}

/** 2-opt and Or-opt on the movable positions `lo..hi` (in place). */
function improve(p: Path, lo: number, hi: number) {
  const L = p.s.length;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let done = false;
    for (let i = lo; i < hi && !done; i++) {
      for (let j = i + 1; j <= hi; j++) {
        if (p.reversal(i, j) > EPS) {
          p.applyReversal(i, j);
          done = true;
          break;
        }
      }
    }
    for (let len = 1; len <= 3 && !done; len++) {
      for (let i = lo; i + len - 1 <= hi && !done; i++) {
        const j = i + len - 1;
        // Gaps that keep the segment within lo..hi: after s[lo-1] … after s[hi] (end gap only when hi is the last).
        for (let g = lo - 1; g <= Math.min(hi, L - 1) && !done; g++) {
          if (g >= i - 1 && g <= j) continue; // same place
          for (const reversed of len > 1 ? [false, true] : [false]) {
            if (p.move(i, len, g, reversed) > EPS) {
              p.applyMove(i, len, g, reversed);
              done = true;
              break;
            }
          }
        }
      }
    }
    if (!done) return;
  }
}

/** Nearest-neighbour path from `first` over the free points; fixed end (or the round-trip start) appended. */
function nearest(m: Matrix, f: Frame, first: number): number[] {
  const seq = [first];
  const left = [...Array(f.n).keys()].filter((i) => i !== first && i !== f.end && !(f.round && i === f.start));
  let at = first;
  while (left.length) {
    let bi = 0;
    for (let k = 1; k < left.length; k++) if ((m[at][left[k]] ?? BIG) < (m[at][left[bi]] ?? BIG) - EPS) bi = k;
    at = left[bi];
    seq.push(at);
    left.splice(bi, 1);
  }
  if (f.round) seq.push(f.start!);
  else if (f.end !== undefined) seq.push(f.end);
  return seq;
}

/** Best order found; same shape as Held–Karp's (`start` first, round trip ends with `start`). Null: no full path. */
export function heuristicOrder(m: Matrix, opts: { start?: number; end?: number; quick?: boolean }): number[] | null {
  const restarts = opts.quick ? QUICK_RESTARTS : RESTARTS;
  const kicks = opts.quick ? QUICK_KICKS : KICKS;
  const n = m.length;
  const round = opts.start !== undefined && opts.end === opts.start;
  const f: Frame = { n, start: opts.start, end: round ? undefined : opts.end, round };
  const firsts = f.start !== undefined ? [f.start] : [...Array(n).keys()].filter((i) => i !== f.end);
  const lo = f.start !== undefined ? 1 : 0;
  const fixedTail = f.round || f.end !== undefined ? 1 : 0;

  let best: Path | null = null;
  const better = (p: Path) =>
    !best || p.cost < best.cost - EPS || (Math.abs(p.cost - best.cost) <= EPS && lexLess(p.s, best.s));
  const rnd = prng(n * 7919 + (opts.start ?? 97) * 31 + (opts.end ?? 89));
  const seeds = firsts.map((first) => nearest(m, f, first));
  // Random restarts: a fixed start leaves one nearest-neighbour seed, which often sits in a poor basin.
  const nn = seeds[0];
  const head = nn.slice(0, lo);
  const tail = nn.slice(nn.length - fixedTail);
  const free = nn.slice(lo, nn.length - fixedTail);
  for (let r = 0; r < restarts; r++) {
    const perm = [...free];
    for (let k = perm.length - 1; k > 0; k--) {
      const x = Math.floor(rnd() * (k + 1));
      [perm[k], perm[x]] = [perm[x], perm[k]];
    }
    seeds.push([...head, ...perm, ...tail]);
  }
  for (const seq of seeds) {
    const p = new Path(m, seq);
    const hi = p.s.length - 1 - fixedTail;
    if (hi > lo) improve(p, lo, hi);
    if (better(p)) best = p;
  }
  if (!best) return null;

  const hi = best.s.length - 1 - fixedTail;
  if (hi - lo >= 7) {
    for (let k = 0; k < kicks; k++) {
      const [a, b, c] = [0, 0, 0].map(() => lo + 1 + Math.floor(rnd() * (hi - lo))).sort((x, y) => x - y);
      if (a === b || b === c) continue;
      const s0: number[] = best.s;
      const p = new Path(m, [...s0.slice(0, a), ...s0.slice(b, c), ...s0.slice(a, b), ...s0.slice(c)]);
      improve(p, lo, hi);
      if (better(p)) best = p;
    }
  }
  return best.cost < BIG ? best.s : null;
}
