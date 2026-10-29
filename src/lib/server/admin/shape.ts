import type { z } from "zod";
import type { BudgetConfig } from "./config";
import type { ApiStatsRaw, AiStatsRaw, RecentEventsRaw, UsageStatsRaw, UserStatsRaw } from "./schema";

export type Level = "ok" | "warn" | "over";

/** A counter against a cap: share in percent (not clamped, so 120 % is visible) and a traffic-light level (warn from 80 %). */
export type Meter = { used: number; cap: number; pct: number; level: Level };

export function meter(used: number, cap: number): Meter {
  const pct = cap > 0 ? Math.round((used / cap) * 100) : 0;
  const level: Level = cap > 0 && used >= cap ? "over" : cap > 0 && used >= cap * 0.8 ? "warn" : "ok";
  return { used, cap, pct, level };
}

export function ratePct(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

/** Cache-hit share of input tokens: tokens read from the prompt cache / all input-side tokens. null without calls. */
export function cacheHitShare(input: number, cacheRead: number, cacheCreation: number): number | null {
  return ratePct(cacheRead, input + cacheRead + cacheCreation);
}

export function microToUsd(micro: number): number {
  return Math.round(micro / 10_000) / 100; // cents precision
}

type Raw = {
  users: z.infer<typeof UserStatsRaw>;
  usage: z.infer<typeof UsageStatsRaw>;
  ai: z.infer<typeof AiStatsRaw>;
  api: z.infer<typeof ApiStatsRaw>;
  events: z.infer<typeof RecentEventsRaw>;
};

const AI_TASKS = ["purpose_tags", "group_parse", "plan_generate", "plan_patch"] as const;

export function shapeDashboard(raw: Raw, cfg: BudgetConfig) {
  const maxDay = Math.max(1, ...raw.usage.perDay.map((d) => d.generated + d.patched));
  const perDay = raw.usage.perDay.map((d) => ({ ...d, total: d.generated + d.patched, widthPct: Math.round(((d.generated + d.patched) / maxDay) * 100) }));

  // Always list the four known tasks (0 calls when unused), then any unknown ones.
  const byTask = [
    ...AI_TASKS.map((key) => raw.ai.byTask.find((t) => t.key === key) ?? { key, calls: 0, microUsd: 0 }),
    ...raw.ai.byTask.filter((t) => !(AI_TASKS as readonly string[]).includes(t.key)),
  ];
  const maxTask = Math.max(1, ...byTask.map((t) => t.microUsd));
  const byModel = raw.ai.byModel.map((m) => ({ ...m, widthPct: Math.round((m.microUsd / Math.max(1, ...raw.ai.byModel.map((x) => x.microUsd))) * 100) }));

  const providers = raw.api.providers.map((p) => ({
    ...p,
    errorRatePct: ratePct(p.errorsMonth, p.networkMonth),
    hitSharePct: ratePct(p.callsMonth - p.networkMonth, p.callsMonth),
  }));
  const byProvider = (name: string) => raw.api.providers.find((p) => p.provider === name);
  const adb = byProvider("aerodatabox");
  const ors = byProvider("openrouteservice");
  const geoapify = byProvider("geoapify");

  return {
    users: raw.users,
    usage: { ...raw.usage, perDay },
    ai: {
      today: meter(raw.ai.todayMicroUsd, cfg.aiDailyCapMicroUsd),
      month: meter(raw.ai.monthMicroUsd, cfg.aiMonthlyAlertMicroUsd),
      callsMonth: raw.ai.callsMonth,
      failedMonth: raw.ai.failedMonth,
      cacheHitSharePct: cacheHitShare(raw.ai.inputTokens, raw.ai.cacheReadTokens, raw.ai.cacheCreationTokens),
      byTask: byTask.map((t) => ({ ...t, widthPct: Math.round((t.microUsd / maxTask) * 100) })),
      byModel,
    },
    providers,
    adb: {
      unitsToday: meter(adb?.unitsToday ?? 0, cfg.adbDailyUnits),
      unitsMonth: adb?.unitsMonth ?? 0,
      remaining: raw.api.aerodataboxQuotaRemaining,
      minRemaining: cfg.adbMinRemaining,
      // Same rule as the cron: warn below 2x the margin, over below the margin.
      level: (raw.api.aerodataboxQuotaRemaining === null ? "ok"
        : raw.api.aerodataboxQuotaRemaining < cfg.adbMinRemaining ? "over"
        : raw.api.aerodataboxQuotaRemaining < 2 * cfg.adbMinRemaining ? "warn" : "ok") as Level,
    },
    ors: { requestsToday: meter(ors?.networkToday ?? 0, cfg.orsDailyCap) },
    geoapify: { creditsToday: meter(geoapify?.unitsToday ?? 0, cfg.geoapifyDailyCap) },
    overpass: raw.api.overpassVariants,
    events: raw.events,
  };
}
export type Dashboard = ReturnType<typeof shapeDashboard>;
