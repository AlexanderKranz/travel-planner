import { z } from "zod";

/**
 * Runtime settings an admin can change on the admin page instead of editing Vercel env vars.
 * Pure definitions and resolution (no I/O); the server helper is src/lib/server/settings.ts.
 * Secrets (API keys, CRON_SECRET, Supabase keys) are never settings.
 *
 * Precedence: DB value (admin) > environment variable > code default.
 * Exception: the two switches. An environment value of exactly "false" is a hard emergency off that the
 * database cannot override ("locked").
 */
type Base = { env: string };
export type BoolDef = Base & { kind: "bool"; default: boolean };
export type NumDef = Base & { kind: "usd" | "int"; min: number; max: number; default: number };
export type SettingDef = BoolDef | NumDef;

export const SETTING_DEFS = {
  ai_enabled: { env: "AI_ENABLED", kind: "bool", default: false },
  demo_enabled: { env: "DEMO_ENABLED", kind: "bool", default: false },
  ai_user_daily_usd: { env: "AI_USER_DAILY_USD", kind: "usd", min: 0, max: 100, default: 0.5 },
  ai_admin_daily_usd: { env: "AI_ADMIN_DAILY_USD", kind: "usd", min: 0, max: 100, default: 2 },
  ai_demo_daily_usd: { env: "AI_DEMO_DAILY_USD", kind: "usd", min: 0, max: 100, default: 0.2 },
  ai_global_daily_usd: { env: "AI_GLOBAL_DAILY_USD", kind: "usd", min: 0, max: 1000, default: 5 },
  ai_monthly_alert_usd: { env: "AI_MONTHLY_ALERT_USD", kind: "usd", min: 0, max: 10000, default: 10 },
  aerodatabox_daily_units: { env: "AERODATABOX_DAILY_UNITS", kind: "int", min: 0, max: 1000, default: 40 },
  aerodatabox_min_remaining: { env: "AERODATABOX_MIN_REMAINING", kind: "int", min: 0, max: 100000, default: 40 },
  ors_daily_requests: { env: "ORS_DAILY_REQUESTS", kind: "int", min: 0, max: 5000, default: 200 },
  geoapify_daily_credits: { env: "GEOAPIFY_DAILY_CREDITS", kind: "int", min: 0, max: 3000, default: 2000 },
  alert_errors_24h: { env: "ALERT_ERRORS_24H", kind: "int", min: 0, max: 10000, default: 20 },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTING_DEFS;
export const SETTING_KEYS = Object.keys(SETTING_DEFS) as SettingKey[];
export type SettingValue = boolean | number;
export type SettingSource = "admin" | "env" | "default";
export type ResolvedSetting = { value: SettingValue; source: SettingSource; locked: boolean };

export const isSettingKey = (k: string): k is SettingKey => Object.hasOwn(SETTING_DEFS, k);

/** Zod schema for one setting's value (type and min/max). */
export function settingSchema(key: SettingKey): z.ZodType<SettingValue> {
  const d: SettingDef = SETTING_DEFS[key];
  if (d.kind === "bool") return z.boolean();
  if (d.kind === "int") return z.number().int().min(d.min).max(d.max);
  // usd: at most 2 decimals (cents)
  return z
    .number()
    .min(d.min)
    .max(d.max)
    .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, { message: "max 2 decimals" });
}

/** Input of the save action. */
export const SettingChange = z
  .object({ key: z.string().refine(isSettingKey, "unknown setting"), value: z.unknown() })
  .superRefine((v, ctx) => {
    if (!isSettingKey(v.key)) return;
    if (!settingSchema(v.key).safeParse(v.value).success) ctx.addIssue({ code: "custom", path: ["value"], message: "invalid" });
  });

const envBool = (raw: string | undefined): boolean | null => {
  const s = raw?.trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return null;
};

function envNumber(key: SettingKey, raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return settingSchema(key).safeParse(n).success ? n : null;
}

/**
 * dbValue: the raw jsonb value or undefined when no row. An invalid DB value (wrong type, out of range) is ignored,
 * so a bad row can never turn a budget into something unexpected.
 */
export function resolveSetting(key: SettingKey, dbValue: unknown, envRaw: string | undefined): ResolvedSetting {
  const d: SettingDef = SETTING_DEFS[key];
  if (d.kind === "bool") {
    const e = envBool(envRaw);
    if (e === false) return { value: false, source: "env", locked: true }; // emergency off
    const db = dbValue === undefined ? null : settingSchema(key).safeParse(dbValue);
    if (db?.success) return { value: db.data, source: "admin", locked: false };
    if (e === true) return { value: true, source: "env", locked: false };
    return { value: d.default, source: "default", locked: false };
  }
  const db = dbValue === undefined ? null : settingSchema(key).safeParse(dbValue);
  if (db?.success) return { value: db.data, source: "admin", locked: false };
  const e = envNumber(key, envRaw);
  if (e !== null) return { value: e, source: "env", locked: false };
  return { value: d.default, source: "default", locked: false };
}

/** Resolves every setting. */
export function resolveAll(db: Partial<Record<string, unknown>>, env: Record<string, string | undefined>): Record<SettingKey, ResolvedSetting> {
  return Object.fromEntries(SETTING_KEYS.map((k) => [k, resolveSetting(k, db[k], env[SETTING_DEFS[k].env])])) as Record<SettingKey, ResolvedSetting>;
}

/** The environment as the existing guards read it, with the resolved values written over the setting variables. */
export function overlayEnv(env: Record<string, string | undefined>, resolved: Record<SettingKey, ResolvedSetting>): Record<string, string | undefined> {
  const out = { ...env };
  for (const k of SETTING_KEYS) out[SETTING_DEFS[k].env] = String(resolved[k].value);
  return out;
}
