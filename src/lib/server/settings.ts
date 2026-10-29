import "server-only";
import {
  overlayEnv,
  resolveAll,
  resolveSetting,
  SETTING_DEFS,
  SETTING_KEYS,
  isSettingKey,
  type ResolvedSetting,
  type SettingKey,
  type SettingValue,
} from "@/lib/settings";
import { createSupabaseAdminClient } from "./supabase/admin";

/**
 * Runtime settings (admin page). Precedence: DB value > environment variable > code default; `ai_enabled` and
 * `demo_enabled` set to "false" in the environment are a hard off the DB cannot override.
 *
 * The table `app_settings` is service-role only, so this reads with the secret key (server-only, no user content).
 * Cache: per server instance, 30 s TTL. Saving invalidates the local cache at once; other instances catch up within
 * the TTL. If the table cannot be read the helper falls back to env/defaults (never "unlimited": every setting has a
 * finite default) and retries after a short pause.
 */
export const SETTINGS_TTL_MS = 30_000;
const FAILURE_RETRY_MS = 5_000;

type Cache = { rows: Record<string, unknown>; until: number };
let cache: Cache | null = null;

export function invalidateSettingsCache(): void {
  cache = null;
}

/** Raw DB values by key (unknown keys and rows that are not objects are ignored). */
async function readRows(now: number): Promise<Record<string, unknown>> {
  if (cache && cache.until > now) return cache.rows;
  try {
    const { data, error } = await createSupabaseAdminClient().from("app_settings").select("key, value");
    if (error || !Array.isArray(data)) throw new Error("read failed");
    const rows: Record<string, unknown> = {};
    for (const r of data as unknown[]) {
      const row = r as { key?: unknown; value?: unknown };
      if (typeof row?.key === "string" && isSettingKey(row.key) && row.value !== undefined && row.value !== null) rows[row.key] = row.value;
    }
    cache = { rows, until: now + SETTINGS_TTL_MS };
    return rows;
  } catch {
    console.error("app_settings read failed, using env/defaults");
    cache = { rows: {}, until: now + FAILURE_RETRY_MS };
    return {};
  }
}

export async function getAllSettings(now: number = Date.now()): Promise<Record<SettingKey, ResolvedSetting>> {
  return resolveAll(await readRows(now), process.env);
}

export async function getSetting<K extends SettingKey>(key: K, now: number = Date.now()): Promise<ResolvedSetting> {
  const rows = await readRows(now);
  return resolveSetting(key, rows[key], process.env[SETTING_DEFS[key].env]);
}

/**
 * `process.env` with the resolved settings written over the setting variables (as strings), for the existing guards
 * that take an `env` argument (isAiEnabled, userCapMicroUsd, orsDailyCap, readBudgetConfig, isDemoEnabled ...).
 */
export async function getEffectiveEnv(now: number = Date.now()): Promise<Record<string, string | undefined>> {
  return overlayEnv(process.env, await getAllSettings(now));
}

export { SETTING_KEYS };
export type { SettingValue };
