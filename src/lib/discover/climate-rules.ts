import type { MonthlyClimate } from "@/lib/domain/facts";
import type { InterestKey } from "@/lib/domain/interests";

/**
 * Climate rules per interest, applied to the mean of the selected months (spec section 6). Starting values, to be
 * tuned on real results. Interests without a rule always pass: the climate is shown, never filtered.
 * Bounds are inclusive.
 */
export type ClimateMean = { tMaxC: number; tMinC: number; wetDays: number };
type Rule = { min?: Partial<ClimateMean>; max?: Partial<ClimateMean> };

export const CLIMATE_RULES: Partial<Record<InterestKey, Rule>> = {
  golf: { min: { tMaxC: 12 }, max: { wetDays: 12 } },
  beach: { min: { tMaxC: 23 } },
  hiking: { min: { tMaxC: 5 }, max: { tMaxC: 32 } },
  cycling: { min: { tMaxC: 10 }, max: { wetDays: 14 } },
  skiing: { max: { tMinC: 0 } },
};

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Mean of the selected months; null when none of them is in the data. */
export function climateMean(months: MonthlyClimate[], selected: number[]): ClimateMean | null {
  const rows = months.filter((m) => selected.includes(m.month));
  if (rows.length === 0) return null;
  return {
    tMaxC: mean(rows.map((m) => m.tMaxC)),
    tMinC: mean(rows.map((m) => m.tMinC)),
    wetDays: mean(rows.map((m) => m.wetDays)),
  };
}

export function passesClimate(interest: InterestKey, m: ClimateMean): boolean {
  const rule = CLIMATE_RULES[interest];
  if (!rule) return true;
  for (const [k, v] of Object.entries(rule.min ?? {})) if (m[k as keyof ClimateMean] < v) return false;
  for (const [k, v] of Object.entries(rule.max ?? {})) if (m[k as keyof ClimateMean] > v) return false;
  return true;
}

/** Every searched interest must pass (no interests = passes). */
export function passesAllClimate(interests: readonly InterestKey[], m: ClimateMean): boolean {
  return interests.every((i) => passesClimate(i, m));
}
