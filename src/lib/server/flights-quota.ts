import "server-only";
import { createSupabaseAdminClient } from "./supabase/admin";
import { getEffectiveEnv } from "./settings";

/**
 * Quota guard for AeroDataBox (RapidAPI Basic: 400 units/month). Spec phase 4, section 1.3.
 * Daily cap counts units of ALL api_calls rows (also failed ones: 400s cost units) since Europe/Berlin midnight.
 */
export class QuotaGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaGuardError";
  }
}

export type QuotaState = { usedToday: number; dailyCap: number; remaining: number | null; minRemaining: number };

function intEnvFrom(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const n = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function berlinOffsetMs(at: number): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", timeZoneName: "longOffset" })
    .formatToParts(new Date(at))
    .find((p) => p.type === "timeZoneName")?.value;
  const m = part?.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
}

/** UTC instant of the most recent Europe/Berlin midnight (DST-safe). */
export function berlinMidnightUtc(now: Date = new Date()): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(now); // YYYY-MM-DD
  const [y, m, d] = ymd.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d);
  const first = wall - berlinOffsetMs(wall);
  return new Date(wall - berlinOffsetMs(first));
}

export async function getQuotaState(now: Date = new Date()): Promise<QuotaState> {
  const env = await getEffectiveEnv(); // admin-page settings > env > defaults
  const admin = createSupabaseAdminClient();
  const since = berlinMidnightUtc(now).toISOString();
  const [sum, last] = await Promise.all([
    admin.from("api_calls").select("units").eq("provider", "aerodatabox").gte("created_at", since).not("units", "is", null),
    admin
      .from("api_calls")
      .select("quota_remaining")
      .eq("provider", "aerodatabox")
      .not("quota_remaining", "is", null)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  if (sum.error) throw new Error("quota read failed");
  const usedToday = (sum.data ?? []).reduce((n, r) => n + (r.units ?? 0), 0);
  return {
    usedToday,
    dailyCap: intEnvFrom(env, "AERODATABOX_DAILY_UNITS", 40),
    remaining: last.data?.[0]?.quota_remaining ?? null,
    minRemaining: intEnvFrom(env, "AERODATABOX_MIN_REMAINING", 40),
  };
}

/** Pure decision (testable). */
export function checkUnits(s: QuotaState, cost: number): string | null {
  if (s.usedToday + cost > s.dailyCap) return "daily cap";
  if (s.remaining !== null && s.remaining - cost < s.minRemaining) return "monthly margin";
  return null;
}

/** Throws QuotaGuardError when `cost` more units would break the daily cap or the monthly safety margin. */
export async function assertUnits(cost: number): Promise<void> {
  let state: QuotaState;
  try {
    state = await getQuotaState();
  } catch {
    throw new QuotaGuardError("quota state unavailable"); // fail closed: never spend blind
  }
  const reason = checkUnits(state, cost);
  if (reason) throw new QuotaGuardError(`AeroDataBox ${reason} reached`);
}
