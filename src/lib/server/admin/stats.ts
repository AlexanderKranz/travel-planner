import "server-only";
import { isAiEnabled } from "../ai-usage";
import { isDemoEnabled } from "../demo";
import { checkDb } from "../health";
import { createSupabaseAdminClient } from "../supabase/admin";
import { readBudgetConfig } from "./config";
import { requireAdmin } from "./gate";
import { adminPeriods } from "./periods";
import { ApiStatsRaw, AiStatsRaw, RecentEventsRaw, UsageStatsRaw, UserStatsRaw } from "./schema";
import { shapeDashboard } from "./shape";

type Env = Record<string, string | undefined>;

/** Which secrets/config are set. Booleans only, never a value. */
export function keyPresence(env: Env = process.env) {
  const has = (k: string) => Boolean(env[k]?.trim());
  return {
    supabaseSecretKey: has("SUPABASE_SECRET_KEY"),
    anthropicKey: has("ANTHROPIC_API_KEY"),
    aerodataboxKey: has("AERODATABOX_API_KEY"),
    openrouteserviceKey: has("OPENROUTESERVICE_API_KEY"),
    sentryDsn: has("NEXT_PUBLIC_SENTRY_DSN"),
    cronSecret: has("CRON_SECRET"),
    integrationsContact: has("INTEGRATIONS_CONTACT"),
  };
}

async function rpc<T>(name: string, args: Record<string, unknown>, schema: { parse: (v: unknown) => T }): Promise<T> {
  // Secret key on purpose (RLS bypass): the admin_* functions are executable by service_role only and return
  // aggregates. Called only after requireAdmin() succeeded.
  const { data, error } = await createSupabaseAdminClient().rpc(name, args);
  if (error) throw new Error(`${name} failed`);
  return schema.parse(data);
}

/** Everything the admin page shows. Verifies the admin role FIRST; non-admins get the 404 page and no query runs. */
export async function getAdminDashboard(now: Date = new Date()) {
  await requireAdmin();
  const p = adminPeriods(now);
  const day = p.dayStart.toISOString();
  const month = p.monthStart.toISOString();
  const [users, usage, ai, api, events] = await Promise.all([
    rpc("admin_user_stats", { p_now: now.toISOString(), p_month_start: month }, UserStatsRaw),
    rpc("admin_usage_stats", { p_month_start: month, p_days: 14 }, UsageStatsRaw),
    rpc("admin_ai_stats", { p_day_start: day, p_month_start: month }, AiStatsRaw),
    rpc("admin_api_stats", { p_day_start: day, p_month_start: month }, ApiStatsRaw),
    rpc("admin_recent_events", { p_limit: 50 }, RecentEventsRaw),
  ]);
  return shapeDashboard({ users, usage, ai, api, events }, readBudgetConfig());
}

/** DB reachability, feature switches, key presence and the last cron run (timestamp only). Admin only. */
export async function getHealthInfo(env: Env = process.env) {
  await requireAdmin();
  const db = await checkDb();
  let lastCronAt: string | null = null;
  try {
    const { data } = await createSupabaseAdminClient()
      .from("app_events")
      .select("created_at")
      .eq("event", "cron.budget_check")
      .order("created_at", { ascending: false })
      .limit(1);
    lastCronAt = data?.[0]?.created_at ?? null;
  } catch {
    lastCronAt = null;
  }
  return {
    db,
    aiEnabled: isAiEnabled(env),
    demoEnabled: isDemoEnabled(env),
    commit: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    keys: keyPresence(env),
    lastCronAt,
  };
}
