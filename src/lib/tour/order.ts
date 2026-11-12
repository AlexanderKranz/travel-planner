/**
 * Tour order (docs/specs/city-tour.md section 4 [T6]): exact Held–Karp over one duration matrix, pure.
 *
 * Result `order` lists every point index once, start first. A round trip (`end === start`) ends with the start index
 * again, so the legs are always the consecutive pairs of `order`.
 *
 * Ties: among all optimal orders the lexicographically smallest index sequence wins (input order), so the result is
 * deterministic. Durations are compared with a tolerance of 1e-6 s to absorb float sums.
 *
 * Unreachable rule: `null` edges are never used. If an order exists that avoids them, it is returned (an unused
 * null pair does not matter). If none exists, `{ error: "unreachable" }` lists every null off-diagonal pair
 * `[from, to]` of the matrix (for "keep": the null legs of the given order); the server flags the points that occur
 * in them (a point ORS cannot route has a full null row and column).
 */

export type Matrix = readonly (readonly (number | null)[])[];
export type OrderOpts = { start?: number; end?: number; keep?: boolean };
export type OrderResult = { order: number[] } | { error: "unreachable"; pairs: [number, number][] };

export const MAX_ORDER_POINTS = 12;
const EPS = 1e-6;

function nullPairs(m: Matrix, seq?: number[]): [number, number][] {
  const out: [number, number][] = [];
  if (seq) {
    for (let i = 0; i + 1 < seq.length; i++) if (m[seq[i]][seq[i + 1]] == null) out.push([seq[i], seq[i + 1]]);
    return out;
  }
  for (let i = 0; i < m.length; i++) for (let j = 0; j < m.length; j++) if (i !== j && m[i][j] == null) out.push([i, j]);
  return out;
}

/** The input order: start first, the others by index, end last (round trip: start again). */
export function keepOrder(n: number, opts: Pick<OrderOpts, "start" | "end">): number[] {
  const { start, end } = opts;
  const mid = [...Array(n).keys()].filter((i) => i !== start && i !== end);
  const seq = start !== undefined ? [start, ...mid] : mid;
  if (end !== undefined) seq.push(end);
  return seq;
}

export function orderTour(m: Matrix, opts: OrderOpts): OrderResult {
  const n = m.length;
  if (n > MAX_ORDER_POINTS) throw new Error(`orderTour: at most ${MAX_ORDER_POINTS} points`);
  const { start, end, keep } = opts;
  for (const i of [start, end]) if (i !== undefined && (i < 0 || i >= n)) throw new Error("orderTour: bad index");
  const round = start !== undefined && end === start;

  if (keep) {
    const seq = keepOrder(n, { start, end });
    const pairs = nullPairs(m, seq);
    return pairs.length ? { error: "unreachable", pairs } : { order: seq };
  }
  if (n === 0) return { order: [] };
  if (n === 1) return { order: round ? [0, 0] : [0] };

  const full = (1 << n) - 1;
  const edge = (i: number, j: number) => m[i][j] ?? Infinity;
  // g[mask * n + j]: least cost to finish when at j with the points in `mask` visited.
  const g = new Float64Array((full + 1) * n).fill(Infinity);
  for (let j = 0; j < n; j++) {
    g[full * n + j] = round ? edge(j, start) : end !== undefined ? (j === end ? 0 : Infinity) : 0;
  }
  for (let mask = full - 1; mask > 0; mask--) {
    for (let j = 0; j < n; j++) {
      if (!(mask & (1 << j))) continue;
      let best = Infinity;
      for (let k = 0; k < n; k++) {
        if (mask & (1 << k)) continue;
        const c = edge(j, k) + g[(mask | (1 << k)) * n + k];
        if (c < best) best = c;
      }
      g[mask * n + j] = best;
    }
  }

  const starts = start !== undefined ? [start] : [...Array(n).keys()];
  let first = -1;
  let total = Infinity;
  for (const s of starts) {
    const c = g[(1 << s) * n + s];
    if (c < total - EPS) {
      total = c;
      first = s;
    }
  }
  if (!Number.isFinite(total)) return { error: "unreachable", pairs: nullPairs(m) };

  const order = [first];
  let mask = 1 << first;
  let at = first;
  while (mask !== full) {
    const want = g[mask * n + at];
    for (let k = 0; k < n; k++) {
      if (mask & (1 << k)) continue;
      const c = edge(at, k) + g[(mask | (1 << k)) * n + k];
      if (Math.abs(c - want) <= EPS) {
        order.push(k);
        mask |= 1 << k;
        at = k;
        break;
      }
    }
  }
  if (round) order.push(start);
  return { order };
}

/** Sum of the matrix durations along `seq` (null when a leg is missing). */
export function pathSeconds(m: Matrix, seq: number[]): number | null {
  let s = 0;
  for (let i = 0; i + 1 < seq.length; i++) {
    const d = m[seq[i]][seq[i + 1]];
    if (d == null) return null;
    s += d;
  }
  return s;
}
