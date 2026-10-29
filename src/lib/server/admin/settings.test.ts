import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
const adminSession = vi.fn();
vi.mock("./gate", () => ({ getAdminSession: () => adminSession() }));
const logEvent = vi.fn<(e: unknown) => Promise<void>>(async () => {});
vi.mock("../events", () => ({ logEvent: (e: unknown) => logEvent(e) }));

const h = vi.hoisted(() => ({
  rows: [] as { key: string; value: unknown }[],
  upserts: [] as unknown[],
  deletes: [] as string[],
  events: [] as unknown[],
  upsertError: null as unknown,
}));
const client = vi.fn(() => ({
  from: (table: string) => {
    if (table === "app_settings") {
      return {
        select: async () => ({ data: h.rows, error: null }),
        upsert: async (row: { key: string; value: unknown }) => {
          h.upserts.push(row);
          if (!h.upsertError) h.rows = [...h.rows.filter((r) => r.key !== row.key), { key: row.key, value: row.value }];
          return { error: h.upsertError };
        },
        delete: () => ({
          eq: async (_c: string, key: string) => {
            h.deletes.push(key);
            h.rows = h.rows.filter((r) => r.key !== key);
            return { error: null };
          },
        }),
      };
    }
    // app_events (recent changes)
    return { select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: h.events, error: null }) }) }) }) };
  },
}));
vi.mock("../supabase/admin", () => ({ createSupabaseAdminClient: () => client() }));

import { resetRateLimits } from "../rate-limit";
import { invalidateSettingsCache } from "../settings";
import { listSettings, resetSetting, saveSetting } from "./settings";

beforeEach(() => {
  h.rows = [];
  h.upserts = [];
  h.deletes = [];
  h.events = [];
  h.upsertError = null;
  client.mockClear();
  adminSession.mockReset();
  adminSession.mockResolvedValue({ userId: "admin-1" });
  logEvent.mockClear();
  resetRateLimits();
  invalidateSettingsCache();
  vi.stubEnv("AI_ENABLED", "");
  vi.stubEnv("DEMO_ENABLED", "");
  vi.stubEnv("AI_USER_DAILY_USD", "");
});

describe("admin gate", () => {
  it("a non-admin gets forbidden and never reaches the secret-key client", async () => {
    adminSession.mockResolvedValue(null);
    expect(await saveSetting({ key: "ai_enabled", value: true })).toEqual({ ok: false, error: "forbidden" });
    expect(await resetSetting({ key: "ai_enabled" })).toEqual({ ok: false, error: "forbidden" });
    expect(await listSettings()).toEqual({ ok: false, error: "forbidden" });
    expect(client).not.toHaveBeenCalled();
  });
});

describe("saveSetting", () => {
  it("validates key and value (type, range) before touching the DB", async () => {
    expect(await saveSetting({ key: "ANTHROPIC_API_KEY", value: 1 })).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveSetting({ key: "ai_user_daily_usd", value: 1000 })).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveSetting({ key: "ai_enabled", value: "true" })).toMatchObject({ ok: false, error: "invalid" });
    expect(h.upserts).toHaveLength(0);
  });

  it("stores the value, takes effect at once (cache invalidated) and audits old and new", async () => {
    vi.stubEnv("AI_USER_DAILY_USD", "0.80");
    expect(await saveSetting({ key: "ai_user_daily_usd", value: 1.5 })).toEqual({ ok: true });
    expect(h.upserts[0]).toMatchObject({ key: "ai_user_daily_usd", value: 1.5, updated_by: "admin-1" });
    const view = await listSettings();
    expect(view.ok && view.data.settings.find((s) => s.key === "ai_user_daily_usd")).toMatchObject({ value: 1.5, source: "admin" });
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "settings.changed", userId: "admin-1", props: { key: "ai_user_daily_usd", old: 0.8, new: 1.5, oldSource: "env" } }),
    );
  });

  it("refuses to write while the environment hard-off is set", async () => {
    vi.stubEnv("AI_ENABLED", "false");
    expect(await saveSetting({ key: "ai_enabled", value: true })).toEqual({ ok: false, error: "forbidden" });
    expect(h.upserts).toHaveLength(0);
    const view = await listSettings();
    expect(view.ok && view.data.settings.find((s) => s.key === "ai_enabled")).toMatchObject({ value: false, locked: true, source: "env" });
  });

  it("reports a failed write and does not audit it", async () => {
    h.upsertError = { code: "42P01" };
    expect(await saveSetting({ key: "ors_daily_requests", value: 5 })).toEqual({ ok: false, error: "failed" });
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("is rate limited (20 changes per minute per admin)", async () => {
    for (let i = 0; i < 20; i++) expect((await saveSetting({ key: "ors_daily_requests", value: i })).ok).toBe(true);
    expect(await saveSetting({ key: "ors_daily_requests", value: 99 })).toEqual({ ok: false, error: "rate_limited" });
    expect(await resetSetting({ key: "ors_daily_requests" })).toEqual({ ok: false, error: "rate_limited" });
  });
});

describe("resetSetting", () => {
  it("deletes the DB value so the env/default applies again, and audits it", async () => {
    h.rows = [{ key: "alert_errors_24h", value: 5 }];
    expect(await resetSetting({ key: "alert_errors_24h" })).toEqual({ ok: true });
    expect(h.deletes).toEqual(["alert_errors_24h"]);
    const view = await listSettings();
    expect(view.ok && view.data.settings.find((s) => s.key === "alert_errors_24h")).toMatchObject({ value: 20, source: "default" });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ props: { key: "alert_errors_24h", old: 5, new: 20, reset: true } }));
  });
  it("rejects unknown keys", async () => {
    expect(await resetSetting({ key: "cron_secret" })).toMatchObject({ ok: false, error: "invalid" });
    expect(h.deletes).toHaveLength(0);
  });
});

describe("listSettings", () => {
  it("returns all 11 settings and the recent changes without user ids", async () => {
    h.events = [
      { created_at: "2026-11-01T10:00:00Z", props: { key: "ai_enabled", old: false, new: true, oldSource: "default" }, user_id: "admin-1" },
      { created_at: "2026-11-01T09:00:00Z", props: { weird: 1 } },
    ];
    const r = await listSettings();
    expect(r.ok && r.data.settings).toHaveLength(11);
    expect(r.ok && r.data.changes).toEqual([{ at: "2026-11-01T10:00:00Z", key: "ai_enabled", old: false, new: true }]);
  });
});
