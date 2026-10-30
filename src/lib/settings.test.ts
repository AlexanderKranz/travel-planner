import { describe, expect, it } from "vitest";
import { overlayEnv, resolveAll, resolveSetting, SETTING_DEFS, SETTING_KEYS, SettingChange, settingSchema } from "./settings";

describe("resolveSetting precedence: DB > env > default", () => {
  it("number: DB wins over env, env over default", () => {
    expect(resolveSetting("ai_user_daily_usd", 1.25, "0.80")).toEqual({ value: 1.25, source: "admin", locked: false });
    expect(resolveSetting("ai_user_daily_usd", undefined, "0.80")).toEqual({ value: 0.8, source: "env", locked: false });
    expect(resolveSetting("ai_user_daily_usd", undefined, undefined)).toEqual({ value: 0.5, source: "default", locked: false });
    expect(resolveSetting("ors_daily_requests", undefined, "")).toEqual({ value: 400, source: "default", locked: false });
  });
  it("an invalid DB value is ignored (wrong type, out of range, too many decimals)", () => {
    expect(resolveSetting("ors_daily_requests", "lots", "300").source).toBe("env");
    expect(resolveSetting("ors_daily_requests", 99999, "300")).toMatchObject({ value: 300, source: "env" });
    expect(resolveSetting("ai_user_daily_usd", 0.123, undefined)).toMatchObject({ value: 0.5, source: "default" });
    expect(resolveSetting("ai_user_daily_usd", -1, undefined).source).toBe("default");
  });
  it("an invalid env value falls to the default; zero is a valid cap", () => {
    expect(resolveSetting("alert_errors_24h", undefined, "abc")).toMatchObject({ value: 20, source: "default" });
    expect(resolveSetting("alert_errors_24h", undefined, "0")).toMatchObject({ value: 0, source: "env" });
  });
  it("switch: DB can turn it on or off when the env does not force it off", () => {
    expect(resolveSetting("ai_enabled", true, undefined)).toEqual({ value: true, source: "admin", locked: false });
    expect(resolveSetting("ai_enabled", false, "true")).toEqual({ value: false, source: "admin", locked: false });
    expect(resolveSetting("ai_enabled", undefined, "true")).toEqual({ value: true, source: "env", locked: false });
    expect(resolveSetting("ai_enabled", undefined, "")).toEqual({ value: false, source: "default", locked: false });
  });
  it("env 'false' is a hard emergency off that the DB cannot override", () => {
    for (const key of ["ai_enabled", "demo_enabled"] as const) {
      expect(resolveSetting(key, true, "false")).toEqual({ value: false, source: "env", locked: true });
      expect(resolveSetting(key, true, " FALSE ")).toMatchObject({ value: false, locked: true });
    }
  });
});

describe("validation", () => {
  it("every key has a schema that accepts its default and the min/max edges", () => {
    for (const k of SETTING_KEYS) {
      const d = SETTING_DEFS[k];
      const s = settingSchema(k);
      expect(s.safeParse(d.default).success, k).toBe(true);
      if (d.kind !== "bool") {
        expect(s.safeParse(d.min).success, `${k} min`).toBe(true);
        expect(s.safeParse(d.max).success, `${k} max`).toBe(true);
        expect(s.safeParse(d.max + 1).success, `${k} above max`).toBe(false);
        expect(s.safeParse(d.min - 1).success, `${k} below min`).toBe(false);
        expect(s.safeParse("5").success, `${k} string`).toBe(false);
      } else {
        expect(s.safeParse("true").success, `${k} string`).toBe(false);
      }
    }
  });
  it("integers only for unit counts; cents only for dollars", () => {
    expect(settingSchema("aerodatabox_daily_units").safeParse(1.5).success).toBe(false);
    expect(settingSchema("ai_global_daily_usd").safeParse(2.5).success).toBe(true);
    expect(settingSchema("ai_global_daily_usd").safeParse(2.555).success).toBe(false);
  });
  it("SettingChange rejects unknown keys (no secret can be addressed) and bad values", () => {
    expect(SettingChange.safeParse({ key: "ai_enabled", value: true }).success).toBe(true);
    expect(SettingChange.safeParse({ key: "ANTHROPIC_API_KEY", value: 1 }).success).toBe(false);
    expect(SettingChange.safeParse({ key: "cron_secret", value: 1 }).success).toBe(false);
    expect(SettingChange.safeParse({ key: "__proto__", value: 1 }).success).toBe(false);
    expect(SettingChange.safeParse({ key: "ai_enabled", value: "yes" }).success).toBe(false);
    expect(SettingChange.safeParse({ key: "ors_daily_requests", value: -1 }).success).toBe(false);
  });
  it("only the listed variables are settings, none of them a secret", () => {
    const envNames = SETTING_KEYS.map((k) => SETTING_DEFS[k].env);
    expect(envNames.some((n) => /KEY|SECRET|PASSWORD|TOKEN|DSN/.test(n))).toBe(false);
    expect(envNames).toHaveLength(12);
  });
});

describe("overlayEnv", () => {
  it("writes the resolved values over the setting variables and leaves the rest alone", () => {
    const env = { AI_ENABLED: "true", AI_USER_DAILY_USD: "0.50", ANTHROPIC_API_KEY: "sk-x", OTHER: "1" };
    const out = overlayEnv(env, resolveAll({ ai_user_daily_usd: 1.5, ai_enabled: false }, env));
    expect(out.AI_USER_DAILY_USD).toBe("1.5");
    expect(out.AI_ENABLED).toBe("false");
    expect(out.ANTHROPIC_API_KEY).toBe("sk-x");
    expect(out.OTHER).toBe("1");
    expect(out.ORS_DAILY_REQUESTS).toBe("400");
    expect(env.AI_ENABLED).toBe("true"); // input not mutated
  });
});
