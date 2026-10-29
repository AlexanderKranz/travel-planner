"use server";

import { z } from "zod";
import { fail, zodIssues, type ActionResult } from "@/lib/domain/result";
import { isSettingKey, SETTING_KEYS, SettingChange, type ResolvedSetting, type SettingKey, type SettingValue } from "@/lib/settings";
import { logEvent } from "../events";
import { rateLimit } from "../rate-limit";
import { getAllSettings, invalidateSettingsCache } from "../settings";
import { createSupabaseAdminClient } from "../supabase/admin";
import { getAdminSession } from "./gate";

/**
 * Admin-page settings (spec phase-6-hardening, section 6). Every entry point checks the admin role first
 * (the non-throwing variant of requireAdmin, so an action returns a typed error instead of a 404 page).
 * The table is service-role only, so writes use the secret key AFTER that check. Values are Zod-validated
 * per key (type, min, max). Every change is audited in app_events ("settings.changed": key, old, new; numbers and
 * booleans only, never a secret, and the table cannot hold one).
 */

const CHANGES_PER_MINUTE = 20;

export type SettingRow = { key: SettingKey } & ResolvedSetting;
export type SettingChangeEntry = { at: string; key: string; old: SettingValue | null; new: SettingValue | null };

const Key = z.object({ key: z.string().refine(isSettingKey, "unknown setting") });

export async function listSettings(): Promise<ActionResult<{ settings: SettingRow[]; changes: SettingChangeEntry[] }>> {
  const session = await getAdminSession();
  if (!session) return fail("forbidden");
  const all = await getAllSettings();
  const settings = SETTING_KEYS.map((key) => ({ key, ...all[key] }));
  let changes: SettingChangeEntry[] = [];
  try {
    const { data } = await createSupabaseAdminClient()
      .from("app_events")
      .select("created_at, props")
      .eq("event", "settings.changed")
      .order("created_at", { ascending: false })
      .limit(20);
    changes = (data ?? []).flatMap((r: { created_at: string; props: Record<string, unknown> | null }) => {
      const p = r.props ?? {};
      const val = (v: unknown): SettingValue | null => (typeof v === "boolean" || typeof v === "number" ? v : null);
      return typeof p.key === "string" ? [{ at: r.created_at, key: p.key, old: val(p.old), new: val(p.new) }] : [];
    });
  } catch {
    changes = [];
  }
  return { ok: true, data: { settings, changes } };
}

export async function saveSetting(input: { key: string; value: unknown }): Promise<ActionResult> {
  const session = await getAdminSession();
  if (!session) return fail("forbidden");
  if (!rateLimit(`settings:${session.userId}`, CHANGES_PER_MINUTE, 60_000).ok) return fail("rate_limited");
  const parsed = SettingChange.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const key = parsed.data.key as SettingKey;
  const value = parsed.data.value as SettingValue;

  const before = (await getAllSettings())[key];
  if (before.locked) return fail("forbidden"); // emergency off in the environment wins; the DB is not even written

  const { error } = await createSupabaseAdminClient()
    .from("app_settings")
    .upsert({ key, value, updated_at: new Date().toISOString(), updated_by: session.userId }, { onConflict: "key" });
  if (error) return fail("failed");
  invalidateSettingsCache(); // other instances catch up within the cache TTL (30 s)
  await logEvent({
    event: "settings.changed",
    userId: session.userId,
    route: "action:saveSetting",
    props: { key, old: before.value, new: value, oldSource: before.source },
  });
  return { ok: true };
}

/** Deletes the DB value, so the environment variable or the code default applies again. */
export async function resetSetting(input: { key: string }): Promise<ActionResult> {
  const session = await getAdminSession();
  if (!session) return fail("forbidden");
  if (!rateLimit(`settings:${session.userId}`, CHANGES_PER_MINUTE, 60_000).ok) return fail("rate_limited");
  const parsed = Key.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const key = parsed.data.key as SettingKey;

  const before = (await getAllSettings())[key];
  const { error } = await createSupabaseAdminClient().from("app_settings").delete().eq("key", key);
  if (error) return fail("failed");
  invalidateSettingsCache();
  const after = (await getAllSettings())[key];
  await logEvent({
    event: "settings.changed",
    userId: session.userId,
    route: "action:resetSetting",
    props: { key, old: before.value, new: after.value, reset: true },
  });
  return { ok: true };
}
