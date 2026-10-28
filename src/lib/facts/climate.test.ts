import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import raw from "../integrations/__fixtures__/open-meteo/archive-malaga-2016-2025.json";
import { parseArchive } from "../integrations/open-meteo-archive";
import { aggregateClimate } from "./climate";

const series = (rows: [string, number | null, number | null, number | null, number | null][]) => ({
  time: rows.map((r) => r[0]),
  tMax: rows.map((r) => r[1]),
  tMin: rows.map((r) => r[2]),
  precip: rows.map((r) => r[3]),
  sunshineS: rows.map((r) => r[4]),
});

describe("aggregateClimate", () => {
  it("aggregates the Malaga fixture into 12 plausible rows", () => {
    const rows = aggregateClimate(parseArchive(raw));
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => r.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const march = rows[2];
    expect(march.tMaxC).toBeGreaterThan(18);
    expect(march.tMaxC).toBeLessThan(21.5);
    expect(rows[6].tMaxC).toBeGreaterThan(28);
    expect(rows[6].precipMm).toBeLessThan(5);
    for (const r of rows) expect(r.tMaxC).toBeGreaterThan(r.tMinC);
  });

  it("is rounded to one decimal", () => {
    for (const r of aggregateClimate(parseArchive(raw))) {
      for (const v of [r.tMaxC, r.tMinC, r.precipMm, r.wetDays, r.sunshineHours]) {
        expect(Math.round(v * 10) / 10).toBe(v);
      }
    }
  });

  it("counts wet days at >= 1 mm, averages monthly totals per year and converts sunshine to hours", () => {
    // Two Januaries (2 full-ish groups are not needed: build 16 days each so the half-month rule passes).
    const rows: [string, number | null, number | null, number | null, number | null][] = [];
    for (const year of ["2020", "2021"]) {
      for (let d = 1; d <= 16; d++) {
        const wet = year === "2020" && d <= 2; // 2 wet days in 2020, 0 in 2021
        rows.push([`${year}-01-${String(d).padStart(2, "0")}`, 10, 2, wet ? 4 : 0.9, 7200]);
      }
    }
    const jan = aggregateClimate(fill(series(rows)))[0];
    expect(jan.wetDays).toBe(1); // (2 + 0) / 2
    expect(jan.precipMm).toBe(Math.round(((16 * 0.9 + 2 * (4 - 0.9) + 16 * 0.9) / 2) * 10) / 10);
    expect(jan.sunshineHours).toBe(2);
    expect(jan.tMaxC).toBe(10);
  });

  it("skips null days and handles leap days", () => {
    const rows: [string, number | null, number | null, number | null, number | null][] = [];
    for (let d = 1; d <= 29; d++) rows.push([`2020-02-${String(d).padStart(2, "0")}`, d === 5 ? null : 10, 0, 0, 3600]);
    const feb = aggregateClimate(fill(series(rows)))[1];
    expect(feb.tMaxC).toBe(10);
    expect(feb.precipMm).toBe(0);
  });

  it("throws when a month has no data", () => {
    expect(() => aggregateClimate(series([["2020-01-01", 1, 1, 1, 1]]))).toThrow(/month 1|month 2/);
  });
});

/** Adds one valid mid-month day for every other month so the 12-month contract is satisfied. */
function fill(s: ReturnType<typeof series>) {
  const have = new Set(s.time.map((t) => Number(t.slice(5, 7))));
  const out = { ...s, time: [...s.time], tMax: [...s.tMax], tMin: [...s.tMin], precip: [...s.precip], sunshineS: [...s.sunshineS] };
  for (let m = 1; m <= 12; m++) {
    if (have.has(m)) continue;
    for (let d = 1; d <= 16; d++) {
      out.time.push(`2020-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
      out.tMax.push(1); out.tMin.push(0); out.precip.push(0); out.sunshineS.push(0);
    }
  }
  return out;
}
