import "server-only";
import type { AiUsageRecord } from "@/lib/domain/ai";
import type { BudgetStatus } from "@/lib/domain/plan";
import { getEffectiveEnv } from "./settings";
import { createSupabaseAdminClient } from "./supabase/admin";

type Env = Record<string, string | undefined>;

export type Role = "user" | "admin";
export type BudgetInfo = BudgetStatus & { globalSpentMicroUsd: number; globalCapMicroUsd: number };

const DEFAULT_USD = { user: 0.5, admin: 2, demo: 0.2, global: 5 } as const;

/** AI is on only with AI_ENABLED === "true" AND an API key (kill switch, spec 5.4). */
export function isAiEnabled(env: Env = process.env): boolean {
  return env.AI_ENABLED === "true" && Boolean(env.ANTHROPIC_API_KEY?.trim());
}

export function usdToMicro(raw: string | undefined, fallbackUsd: number): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Math.round((Number.isFinite(n) && n >= 0 ? n : fallbackUsd) * 1_000_000);
}

/** Per-user daily cap in micro-USD: demo account first, then admin, then normal user. */
export function userCapMicroUsd(role: Role, isDemo: boolean, env: Env = process.env): number {
  if (isDemo) return usdToMicro(env.AI_DEMO_DAILY_USD, DEFAULT_USD.demo);
  if (role === "admin") return usdToMicro(env.AI_ADMIN_DAILY_USD, DEFAULT_USD.admin);
  return usdToMicro(env.AI_USER_DAILY_USD, DEFAULT_USD.user);
}

export function globalCapMicroUsd(env: Env = process.env): number {
  return usdToMicro(env.AI_GLOBAL_DAILY_USD, DEFAULT_USD.global);
}

const berlinParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Europe/Berlin wall clock of an instant, read as if it were UTC (ms). */
function berlinWallAsUtc(ms: number): number {
  const p = Object.fromEntries(berlinParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

/** UTC instant of the Berlin midnight that starts the Berlin day containing `now`, shifted by `dayOffset` days. */
export function berlinMidnight(now: Date, dayOffset = 0): Date {
  const wall = berlinWallAsUtc(now.getTime());
  const dayStartWall = Math.floor(wall / 86_400_000) * 86_400_000 + dayOffset * 86_400_000;
  // Wall-clock → instant: try offset at the guess, then re-check (handles DST switches, which happen at 02:00/03:00).
  let guess = dayStartWall - (wall - now.getTime());
  guess = dayStartWall - (berlinWallAsUtc(guess) - guess);
  guess = dayStartWall - (berlinWallAsUtc(guess) - guess);
  return new Date(guess);
}

/** True when `spent + reserve` stays within the user cap and the global cap. */
export function budgetAllows(info: BudgetInfo, reserveMicroUsd: number): boolean {
  return (
    info.spentMicroUsd + reserveMicroUsd <= info.capMicroUsd &&
    info.globalSpentMicroUsd + reserveMicroUsd <= info.globalCapMicroUsd
  );
}

/**
 * Logs one Claude call. Uses the secret key on purpose (RLS bypass): only the server writes ai_usage.
 * Never throws; metadata only, never prompt or response content.
 */
export async function logAiUsage(userId: string | null, isDemo: boolean, rec: AiUsageRecord): Promise<void> {
  try {
    const admin = createSupabaseAdminClient();
    const { error } = await admin.from("ai_usage").insert({
      user_id: userId,
      task: rec.task,
      model: rec.model,
      status: rec.status,
      input_tokens: rec.inputTokens,
      output_tokens: rec.outputTokens,
      cache_creation_input_tokens: rec.cacheCreationInputTokens,
      cache_read_input_tokens: rec.cacheReadInputTokens,
      cost_micro_usd: rec.costMicroUsd,
      latency_ms: rec.latencyMs,
      is_demo: isDemo,
      error_code: rec.errorCode ? rec.errorCode.slice(0, 60) : null,
    });
    if (error) console.error("logAiUsage failed", error.code);
  } catch (error) {
    console.error("logAiUsage failed", error instanceof Error ? error.name : "unknown");
  }
}

/**
 * Spend since Berlin midnight (user and global) and the caps. Reads with the secret key (aggregate over
 * all users for the global cap; only sums are returned). Fails closed: on a read error the caller must treat
 * the budget as exhausted.
 */
export async function getBudgetStatus(
  userId: string,
  role: Role,
  isDemo: boolean,
  now: Date = new Date(),
  env?: Env,
): Promise<BudgetInfo> {
  const caps = env ?? (await getEffectiveEnv()); // admin-page settings > env > defaults
  const since = berlinMidnight(now);
  const admin = createSupabaseAdminClient();
  // Sums are computed in SQL (a client-side sum would be cut off by PostgREST max_rows and fail open).
  const { data, error } = await admin.rpc("ai_spend_micro_usd", { p_user: userId, p_from: since.toISOString() });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) throw new Error("ai_usage read failed");
  const spent = Number(row.user_spent);
  const globalSpent = Number(row.global_spent);
  if (!Number.isFinite(spent) || !Number.isFinite(globalSpent)) throw new Error("ai_usage read failed");
  return {
    spentMicroUsd: spent,
    capMicroUsd: userCapMicroUsd(role, isDemo, caps),
    resetsAt: berlinMidnight(now, 1).toISOString(),
    globalSpentMicroUsd: globalSpent,
    globalCapMicroUsd: globalCapMicroUsd(caps),
  };
}
