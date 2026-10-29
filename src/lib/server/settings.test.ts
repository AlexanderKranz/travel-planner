import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const select = vi.fn();
const factory = vi.fn(() => ({ from: () => ({ select }) }));
vi.mock("./supabase/admin", () => ({ createSupabaseAdminClient: () => factory() }));

import { getAllSettings, getEffectiveEnv, getSetting, invalidateSettingsCache, SETTINGS_TTL_MS } from "./settings";

beforeEach(() => {
  invalidateSettingsCache();
  select.mockReset();
  select.mockResolvedValue({ data: [], error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("AI_USER_DAILY_USD", "");
  vi.stubEnv("AI_ENABLED", "");
  vi.stubEnv("ORS_DAILY_REQUESTS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("getSetting precedence", () => {
  it("DB value > env > default", async () => {
    vi.stubEnv("AI_USER_DAILY_USD", "0.80");
    expect(await getSetting("ai_user_daily_usd")).toMatchObject({ value: 0.8, source: "env" });
    invalidateSettingsCache();
    select.mockResolvedValue({ data: [{ key: "ai_user_daily_usd", value: 1.5 }], error: null });
    expect(await getSetting("ai_user_daily_usd")).toMatchObject({ value: 1.5, source: "admin" });
    expect(await getSetting("ors_daily_requests")).toMatchObject({ value: 400, source: "default" });
  });

  it("env AI_ENABLED=false is a hard off, the DB cannot turn it on", async () => {
    vi.stubEnv("AI_ENABLED", "false");
    select.mockResolvedValue({ data: [{ key: "ai_enabled", value: true }], error: null });
    expect(await getSetting("ai_enabled")).toEqual({ value: false, source: "env", locked: true });
    expect((await getEffectiveEnv()).AI_ENABLED).toBe("false");
  });

  it("ignores unknown keys, invalid values and null values from the table", async () => {
    select.mockResolvedValue({
      data: [{ key: "anthropic_api_key", value: 1 }, { key: "ors_daily_requests", value: "x" }, { key: "alert_errors_24h", value: null }],
      error: null,
    });
    const all = await getAllSettings();
    expect(all.ors_daily_requests.source).toBe("default");
    expect(all.alert_errors_24h.source).toBe("default");
  });
});

describe("cache", () => {
  it("reads once within the TTL, again after it", async () => {
    await getSetting("ai_enabled", 1000);
    await getSetting("ai_enabled", 1000 + SETTINGS_TTL_MS - 1);
    expect(select).toHaveBeenCalledTimes(1);
    await getSetting("ai_enabled", 1000 + SETTINGS_TTL_MS + 1);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("invalidation makes the next read see the new value at once", async () => {
    select.mockResolvedValue({ data: [], error: null });
    expect((await getSetting("ors_daily_requests", 1000)).source).toBe("default");
    select.mockResolvedValue({ data: [{ key: "ors_daily_requests", value: 10 }], error: null });
    expect((await getSetting("ors_daily_requests", 2000)).source).toBe("default"); // still cached
    invalidateSettingsCache();
    expect(await getSetting("ors_daily_requests", 2000)).toMatchObject({ value: 10, source: "admin" });
  });
});

describe("failure", () => {
  it("falls back to env/defaults when the table cannot be read; budgets stay finite, never unlimited", async () => {
    vi.stubEnv("AI_USER_DAILY_USD", "0.75");
    select.mockResolvedValue({ data: null, error: { code: "42P01" } });
    const all = await getAllSettings(1000);
    expect(all.ai_user_daily_usd).toMatchObject({ value: 0.75, source: "env" });
    expect(all.ai_global_daily_usd).toMatchObject({ value: 5, source: "default" });
    expect(Number.isFinite(all.ai_global_daily_usd.value as number)).toBe(true);
  });
  it("falls back when the client throws (missing secret key), and retries after a short pause", async () => {
    factory.mockImplementationOnce(() => {
      throw new Error("Missing SUPABASE_SECRET_KEY");
    });
    expect((await getSetting("ors_daily_requests", 1000)).source).toBe("default");
    select.mockResolvedValue({ data: [{ key: "ors_daily_requests", value: 7 }], error: null });
    expect((await getSetting("ors_daily_requests", 1500)).source).toBe("default"); // short negative cache
    expect(await getSetting("ors_daily_requests", 7000)).toMatchObject({ value: 7, source: "admin" });
  });
});
