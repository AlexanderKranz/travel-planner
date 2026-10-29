import "server-only";
import * as Sentry from "@sentry/nextjs";
import { logEvent } from "../events";
import { getQuotaState } from "../flights-quota";
import { createSupabaseAdminClient } from "../supabase/admin";
import { evaluateBudget, type Alert, type AlertKind, type BudgetMetrics } from "./budget";
import { readBudgetConfig, type BudgetConfig } from "./config";
import { adminPeriods, type AdminPeriods } from "./periods";
import { getEffectiveEnv } from "../settings";

export type BudgetDeps = {
  config: BudgetConfig;
  readMetrics: (p: AdminPeriods) => Promise<BudgetMetrics>;
  /** True when a `budget.alert` event of this kind exists since `since` (dedupe: one alert per kind per day). */
  alreadySent: (kind: AlertKind, since: Date) => Promise<boolean>;
  deliver: (alert: Alert, day: string) => Promise<void>;
  logRun: (summary: { alerts: number; sent: number }) => Promise<void>;
};

export type BudgetRunResult = { alerts: { kind: AlertKind; level: "warn" | "error"; sent: boolean }[] };

/** All reads are cheap aggregates, so this also doubles as the daily Supabase keep-alive query. */
async function readMetrics(p: AdminPeriods): Promise<BudgetMetrics> {
  // Secret key on purpose (RLS bypass): server-only cron, no user context, aggregates only.
  const admin = createSupabaseAdminClient();
  const spend = async (from: Date) => {
    const { data, error } = await admin.rpc("ai_spend_micro_usd", { p_user: null, p_from: from.toISOString() });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) throw new Error("ai_usage read failed");
    return Number(row.global_spent);
  };
  const [aiTodayMicroUsd, aiMonthMicroUsd, quota, ors, errs] = await Promise.all([
    spend(p.dayStart),
    spend(p.monthStart),
    getQuotaState(p.now),
    admin
      .from("api_calls")
      .select("id", { count: "exact", head: true })
      .eq("provider", "openrouteservice")
      .neq("cache", "hit")
      .gte("created_at", p.dayStart.toISOString()),
    admin
      .from("app_events")
      .select("id", { count: "exact", head: true })
      .eq("level", "error")
      .neq("event", "budget.alert") // our own alerts must not feed the error alert
      .gte("created_at", p.last24h.toISOString()),
  ]);
  if (ors.error || errs.error) throw new Error("budget read failed");
  return {
    aiTodayMicroUsd,
    aiMonthMicroUsd,
    adbRemaining: quota.remaining,
    orsRequestsToday: ors.count ?? 0,
    errors24h: errs.count ?? 0,
  };
}

async function alreadySent(kind: AlertKind, since: Date): Promise<boolean> {
  const { count, error } = await createSupabaseAdminClient()
    .from("app_events")
    .select("id", { count: "exact", head: true })
    .eq("event", "budget.alert")
    .eq("props->>kind", kind)
    .gte("created_at", since.toISOString());
  if (error) throw new Error("dedupe read failed");
  return (count ?? 0) > 0;
}

/**
 * Delivery without a new account: an app_events row (admin page + dedupe record) and a Sentry message, so the
 * existing Sentry alert emails fire. The per-day fingerprint makes every day a NEW Sentry issue, which is what
 * the "new issue" alert condition needs. No-op for Sentry when no DSN is configured.
 */
async function deliver(alert: Alert, day: string): Promise<void> {
  await logEvent({ event: "budget.alert", level: alert.level, route: "cron:budget-check", props: { kind: alert.kind, ...alert.props } });
  Sentry.captureMessage(`Budget alert: ${alert.kind}`, {
    level: "warning",
    tags: { budget_alert: "true", alert_kind: alert.kind, alert_level: alert.level },
    extra: alert.props,
    fingerprint: ["budget-alert", alert.kind, day],
  });
  await Sentry.flush(2000);
}

async function logRun(summary: { alerts: number; sent: number }): Promise<void> {
  await logEvent({ event: "cron.budget_check", route: "cron:budget-check", props: summary });
}

export async function defaultBudgetDeps(): Promise<BudgetDeps> {
  return { config: readBudgetConfig(await getEffectiveEnv()), readMetrics, alreadySent, deliver, logRun };
}

export async function runBudgetCheck(now: Date = new Date(), deps?: BudgetDeps): Promise<BudgetRunResult> {
  deps ??= await defaultBudgetDeps();
  const p = adminPeriods(now);
  const metrics = await deps.readMetrics(p);
  const alerts = evaluateBudget(metrics, deps.config);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(now);
  const result: BudgetRunResult = { alerts: [] };
  for (const alert of alerts) {
    const duplicate = await deps.alreadySent(alert.kind, p.dayStart);
    if (!duplicate) await deps.deliver(alert, day);
    result.alerts.push({ kind: alert.kind, level: alert.level, sent: !duplicate });
  }
  await deps.logRun({ alerts: alerts.length, sent: result.alerts.filter((a) => a.sent).length });
  return result;
}
