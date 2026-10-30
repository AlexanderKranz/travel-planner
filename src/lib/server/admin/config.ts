import { globalCapMicroUsd, usdToMicro } from "../ai-usage";
import { orsDailyCap } from "../facts/drive-times";
import { geoapifyDailyCap } from "../facts/geoapify-quota";

type Env = Record<string, string | undefined>;

/** Budgets the admin page shows and the budget cron checks. Same env vars as the guards that enforce them. */
export type BudgetConfig = {
  aiDailyCapMicroUsd: number;
  aiMonthlyAlertMicroUsd: number;
  adbDailyUnits: number;
  adbMinRemaining: number;
  orsDailyCap: number;
  geoapifyDailyCap: number;
  errors24hThreshold: number;
};

export const DEFAULT_AI_MONTHLY_ALERT_USD = 10;
export const DEFAULT_ERRORS_24H_THRESHOLD = 20;

function intEnvFrom(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function readBudgetConfig(env: Env = process.env): BudgetConfig {
  return {
    aiDailyCapMicroUsd: globalCapMicroUsd(env),
    aiMonthlyAlertMicroUsd: usdToMicro(env.AI_MONTHLY_ALERT_USD, DEFAULT_AI_MONTHLY_ALERT_USD),
    adbDailyUnits: intEnvFrom(env.AERODATABOX_DAILY_UNITS, 40),
    adbMinRemaining: intEnvFrom(env.AERODATABOX_MIN_REMAINING, 40),
    orsDailyCap: orsDailyCap(env),
    geoapifyDailyCap: geoapifyDailyCap(env),
    errors24hThreshold: intEnvFrom(env.ALERT_ERRORS_24H, DEFAULT_ERRORS_24H_THRESHOLD),
  };
}
