import { z } from "zod";

// Shapes returned by the admin_* SQL functions (migration 20261102120025). Counts and sums only.
const n = z.number().nonnegative();

export const UserStatsRaw = z.object({
  total: n, admins: n, active7: n, active30: n, newThisMonth: n,
  demoLogins7: n, demoLogins30: n, demoAiCallsMonth: n, demoAiMicroUsdMonth: n,
});

export const UsageStatsRaw = z.object({
  trips: n, tripsThisMonth: n, plans: n, versionsGenerate: n, versionsPatch: n,
  generatedThisMonth: n, patchedThisMonth: n, shareLinksActive: n,
  perDay: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), generated: n, patched: n })),
});

const Bucket = z.object({ key: z.string(), calls: n, microUsd: n });
export const AiStatsRaw = z.object({
  todayMicroUsd: n, monthMicroUsd: n, callsMonth: n, failedMonth: n,
  inputTokens: n, cacheReadTokens: n, cacheCreationTokens: n, outputTokens: n,
  byTask: z.array(Bucket), byModel: z.array(Bucket),
});

export const ApiStatsRaw = z.object({
  providers: z.array(z.object({
    provider: z.string(), callsToday: n, callsMonth: n, networkToday: n, networkMonth: n, errorsMonth: n,
    p50Ms: n.nullable(), p95Ms: n.nullable(), unitsToday: n, unitsMonth: n,
  })),
  aerodataboxQuotaRemaining: z.number().int().nullable(),
  overpassVariants: z.array(z.object({ variant: z.string(), calls: n, errors: n })),
});

export const RecentEventsRaw = z.array(z.object({
  at: z.string(), level: z.enum(["warn", "error"]), event: z.string(), route: z.string().nullable(), code: z.string().nullable(),
}));
