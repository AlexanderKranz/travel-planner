import type { MonthlyClimate } from "@/lib/domain/facts";
import type { DailySeries } from "@/lib/integrations/open-meteo-archive";

/** 10 full years. Changing it changes the cache key (bump `v` in server/facts/weather.ts). */
export const CLIMATE_PERIOD = { from: 2016, to: 2025 } as const;
export const WET_DAY_MM = 1;

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Per calendar month across all years: mean daily max/min, mean monthly precipitation total,
 * mean number of days with >= 1 mm, mean sunshine hours per day. Null days are skipped; a
 * (year, month) group with fewer than half of its days is ignored for totals and counts.
 * Throws if any month has no data at all.
 */
export function aggregateClimate(s: DailySeries): MonthlyClimate[] {
  type Acc = { tMax: number[]; tMin: number[]; sun: number[]; groups: Map<string, { precip: number; wet: number; n: number }> };
  const acc: Acc[] = Array.from({ length: 12 }, () => ({ tMax: [], tMin: [], sun: [], groups: new Map() }));
  s.time.forEach((date, i) => {
    const m = Number(date.slice(5, 7)) - 1;
    const a = acc[m];
    if (!a) return;
    const hi = s.tMax[i];
    const lo = s.tMin[i];
    const p = s.precip[i];
    const sun = s.sunshineS[i];
    if (typeof hi === "number") a.tMax.push(hi);
    if (typeof lo === "number") a.tMin.push(lo);
    if (typeof sun === "number") a.sun.push(sun / 3600);
    if (typeof p === "number") {
      const key = date.slice(0, 4);
      const g = a.groups.get(key) ?? { precip: 0, wet: 0, n: 0 };
      g.precip += p;
      if (p >= WET_DAY_MM) g.wet += 1;
      g.n += 1;
      a.groups.set(key, g);
    }
  });
  const dim = (month: number) => (month === 2 ? 28 : [4, 6, 9, 11].includes(month) ? 30 : 31);
  return acc.map((a, idx) => {
    const month = idx + 1;
    const groups = [...a.groups.values()].filter((g) => g.n >= dim(month) / 2);
    if (!a.tMax.length || !a.tMin.length || !groups.length || !a.sun.length) {
      throw new Error(`No climate data for month ${month}`);
    }
    return {
      month,
      tMaxC: round1(mean(a.tMax)),
      tMinC: round1(mean(a.tMin)),
      precipMm: round1(mean(groups.map((g) => g.precip))),
      wetDays: round1(mean(groups.map((g) => g.wet))),
      sunshineHours: round1(mean(a.sun)),
    };
  });
}
