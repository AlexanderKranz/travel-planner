import type { BudgetConfig } from "./config";

export type AlertKind = "ai_daily" | "ai_monthly" | "aerodatabox_monthly" | "ors_daily" | "errors_24h";
export type Alert = { kind: AlertKind; level: "warn" | "error"; props: Record<string, number> };

/** Measured values (null = not measurable, e.g. no AeroDataBox call logged yet). */
export type BudgetMetrics = {
  aiTodayMicroUsd: number;
  aiMonthMicroUsd: number;
  adbRemaining: number | null;
  orsRequestsToday: number;
  errors24h: number;
};

export const WARN_AT = 0.8;

function usage(kind: AlertKind, used: number, cap: number, extra: Record<string, number> = {}): Alert | null {
  if (cap <= 0) return null;
  if (used >= cap) return { kind, level: "error", props: { used, cap, pct: Math.round((used / cap) * 100), ...extra } };
  if (used >= cap * WARN_AT) return { kind, level: "warn", props: { used, cap, pct: Math.round((used / cap) * 100), ...extra } };
  return null;
}

/** Pure threshold rules. Warn at 80 % of a cap, error at 100 %; AeroDataBox warns below 2x the margin, errors below it. */
export function evaluateBudget(m: BudgetMetrics, cfg: BudgetConfig): Alert[] {
  const out: (Alert | null)[] = [
    usage("ai_daily", m.aiTodayMicroUsd, cfg.aiDailyCapMicroUsd),
    usage("ai_monthly", m.aiMonthMicroUsd, cfg.aiMonthlyAlertMicroUsd),
    usage("ors_daily", m.orsRequestsToday, cfg.orsDailyCap),
  ];
  if (m.adbRemaining !== null && cfg.adbMinRemaining > 0 && m.adbRemaining < 2 * cfg.adbMinRemaining) {
    out.push({
      kind: "aerodatabox_monthly",
      level: m.adbRemaining < cfg.adbMinRemaining ? "error" : "warn",
      props: { remaining: m.adbRemaining, margin: cfg.adbMinRemaining },
    });
  }
  if (m.errors24h > cfg.errors24hThreshold) {
    out.push({ kind: "errors_24h", level: m.errors24h > cfg.errors24hThreshold * 2 ? "error" : "warn", props: { count: m.errors24h, threshold: cfg.errors24hThreshold } });
  }
  return out.filter((a): a is Alert => a !== null);
}
