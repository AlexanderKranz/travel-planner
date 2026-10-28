import type { DaylightDay, DestinationSummary, MonthlyClimate, WeatherFacts } from "@/lib/domain";

/** Flag emoji from an ISO 3166-1 alpha-2 code; "" if the code is not two letters. */
export function flagEmoji(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return "";
  return [...code.toUpperCase()].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");
}

/** Months to show: the trip's selected months, else the fallback (reference) month, else none. */
export function glanceMonths(w: WeatherFacts, fallbackMonth: number): MonthlyClimate[] {
  const wanted = w.selectedMonths.length ? w.selectedMonths : [fallbackMonth];
  return w.months.filter((m) => wanted.includes(m.month)).sort((a, b) => a.month - b.month);
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export type ClimateGlance = { tMaxC: number; tMinC: number; wetDays: number; sunshineHours: number };

/** Mean over the given months; null when empty. */
export function climateGlance(rows: MonthlyClimate[]): ClimateGlance | null {
  if (!rows.length) return null;
  return {
    tMaxC: avg(rows.map((r) => r.tMaxC)),
    tMinC: avg(rows.map((r) => r.tMinC)),
    wetDays: avg(rows.map((r) => r.wetDays)),
    sunshineHours: avg(rows.map((r) => r.sunshineHours)),
  };
}

/** Representative day: the middle one (trip midpoint or mid-month). */
export function middleDay(days: DaylightDay[]): DaylightDay | null {
  return days.length ? days[Math.floor((days.length - 1) / 2)] : null;
}

/** Paragraphs of the destination text: optional `paragraphs`, else the extract split on newlines. */
export function summaryParagraphs(data: DestinationSummary & { paragraphs?: string[] }): string[] {
  const src = data.paragraphs?.length ? data.paragraphs : data.extract.split(/\n+/);
  return src.map((p) => p.trim()).filter(Boolean);
}
