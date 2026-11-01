import type { CountryFacts, DestinationSummary, MonthlyClimate, WeatherFacts } from "@/lib/domain";
import { monthName } from "@/components/trips/trip-title";

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
export function climateGlance(rows: Omit<MonthlyClimate, "precipMm">[]): ClimateGlance | null {
  if (!rows.length) return null;
  return {
    tMaxC: avg(rows.map((r) => r.tMaxC)),
    tMinC: avg(rows.map((r) => r.tMinC)),
    wetDays: avg(rows.map((r) => r.wetDays)),
    sunshineHours: avg(rows.map((r) => r.sunshineHours)),
  };
}

/** Representative day: the middle one (trip midpoint or mid-month). */
export function middleDay<T>(days: T[]): T | null {
  return days.length ? days[Math.floor((days.length - 1) / 2)] : null;
}

export function regionName(code: string, locale: string, fallback: string) {
  try {
    const n = new Intl.DisplayNames([locale], { type: "region", fallback: "none" }).of(code);
    return n && n.toLowerCase() !== code.toLowerCase() ? n : fallback;
  } catch {
    return fallback;
  }
}

export function currencyLabel(c: CountryFacts["currencies"][number]) {
  return c.symbol && c.symbol !== c.code ? `${c.symbol} ${c.code}` : c.code;
}

export function monthsLabel(months: number[], locale: string) {
  if (months.length === 0) return "";
  if (months.length === 1) return monthName(months[0], locale, "long");
  const contiguous = months.every((m, i) => i === 0 || m === months[i - 1] + 1);
  return contiguous
    ? `${monthName(months[0], locale, "long")}–${monthName(months[months.length - 1], locale, "long")}`
    : months.map((m) => monthName(m, locale)).join(", ");
}

/** Paragraphs of the destination text: optional `paragraphs`, else the extract split on newlines. */
export function summaryParagraphs(data: DestinationSummary & { paragraphs?: string[] }): string[] {
  const src = data.paragraphs?.length ? data.paragraphs : data.extract.split(/\n+/);
  return src.map((p) => p.trim()).filter(Boolean);
}
