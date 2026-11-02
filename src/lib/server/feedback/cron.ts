import "server-only";
import { berlinMidnight } from "../ai-usage";
import { logEvent } from "../events";
import { getSetting } from "../settings";
import { createSupabaseAdminClient } from "../supabase/admin";
import { githubConfig } from "@/lib/integrations/github";
import { deliverFeedback } from "./deliver";
import { removeScreenshotPaths } from "./storage";

/** Daily cron part of the feedback feature (spec D6 and D16). Secret key on purpose: no user context, metadata only. */

export const CRON_BATCH_MAX = 10;
/** No new row is started after this long (each row can take 2 x 10 s), so the function never reaches maxDuration. */
export const CRON_DELIVERY_BUDGET_MS = 60_000;
/** Consecutive network/5xx outcomes after which the run stops (GitHub is down). */
const MAX_CONSECUTIVE_BACKOFFS = 2;
export const SCREENSHOT_RETENTION_DAYS = 90;
export const CREATED_RETENTION_DAYS = 180;
export const OPEN_RETENTION_DAYS = 365;
const DAY_MS = 86_400_000;
const PURGE_BATCH = 100;

export type FeedbackCronResult = { delivered: number; attempted: number; stopped: boolean; screenshotsPurged: number; rowsDeleted: number };

/** Capacity left today: ceiling minus issues created since Berlin midnight minus live leases (same count as `feedback_claim`). */
export async function ceilingLeft(now: Date): Promise<number> {
  const admin = createSupabaseAdminClient();
  const ceiling = Number((await getSetting("feedback_daily_issues", now.getTime())).value);
  const midnight = berlinMidnight(now).toISOString();
  const [created, leased] = await Promise.all([
    admin.from("feedback").select("id", { count: "exact", head: true }).eq("status", "created").gte("issue_created_at", midnight),
    admin.from("feedback").select("id", { count: "exact", head: true }).eq("status", "pending").gt("lease_until", now.toISOString()),
  ]);
  if (created.error || leased.error) throw new Error("feedback ceiling read failed");
  return Math.max(0, ceiling - (created.count ?? 0) - (leased.count ?? 0));
}

/** Delivers due pending rows, oldest first, at most min(10, ceiling left). Stops at the first rate-limit or auth answer. */
export async function deliverDueFeedback(
  now: Date = new Date(),
  clock: { now: () => number; budgetMs: number } = { now: Date.now, budgetMs: CRON_DELIVERY_BUDGET_MS },
): Promise<{ attempted: number; delivered: number; stopped: boolean }> {
  if (!githubConfig()) return { attempted: 0, delivered: 0, stopped: false };
  const batch = Math.min(CRON_BATCH_MAX, await ceilingLeft(now));
  if (batch <= 0) return { attempted: 0, delivered: 0, stopped: false };
  const { data, error } = await createSupabaseAdminClient()
    .from("feedback")
    .select("id")
    .eq("status", "pending")
    .lte("next_attempt_at", now.toISOString())
    .or(`lease_until.is.null,lease_until.lte.${now.toISOString()}`)
    .order("created_at", { ascending: true })
    .limit(batch);
  if (error) throw new Error("feedback due read failed");
  let attempted = 0;
  let delivered = 0;
  let stopped = false;
  let backoffs = 0;
  const started = clock.now();
  for (const { id } of (data ?? []) as { id: string }[]) {
    if (clock.now() - started >= clock.budgetMs) {
      stopped = true;
      break;
    }
    const r = await deliverFeedback(id, { userId: null, now });
    if (r.outcome !== "not_claimed" && r.outcome !== "no_token") attempted++;
    if (r.outcome === "created" || r.outcome === "linked") delivered++;
    backoffs = r.outcome === "backoff" ? backoffs + 1 : 0;
    if (r.stop || backoffs >= MAX_CONSECUTIVE_BACKOFFS) {
      stopped = true;
      break;
    }
  }
  return { attempted, delivered, stopped };
}

/** Screenshots after 90 days, `created` rows after 180 days, `pending`/`failed` rows after 365 days (by `created_at`). */
export async function runFeedbackRetention(now: Date = new Date()): Promise<{ screenshotsPurged: number; rowsDeleted: number }> {
  const admin = createSupabaseAdminClient();
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();

  let screenshotsPurged = 0;
  const { data: old, error } = await admin
    .from("feedback")
    .select("id, screenshot_path")
    .not("screenshot_path", "is", null)
    .lt("created_at", before(SCREENSHOT_RETENTION_DAYS))
    .order("created_at", { ascending: true })
    .limit(PURGE_BATCH);
  if (error) throw new Error("feedback retention read failed");
  const rows = (old ?? []) as { id: string; screenshot_path: string }[];
  if (rows.length > 0 && (await removeScreenshotPaths(rows.map((r) => r.screenshot_path)))) {
    const { error: upd } = await admin.from("feedback").update({ screenshot_path: null }).in("id", rows.map((r) => r.id));
    if (!upd) screenshotsPurged = rows.length;
  }

  // Rows whose screenshot is still stored are kept until the purge above has removed it.
  const del = async (status: string[], days: number) => {
    const { data, error: e } = await admin
      .from("feedback")
      .delete()
      .in("status", status)
      .is("screenshot_path", null)
      .lt("created_at", before(days))
      .select("id");
    if (e) throw new Error("feedback retention delete failed");
    return data?.length ?? 0;
  };
  const rowsDeleted = (await del(["created"], CREATED_RETENTION_DAYS)) + (await del(["pending", "failed"], OPEN_RETENTION_DAYS));
  return { screenshotsPurged, rowsDeleted };
}

/** Both parts, each isolated: a delivery problem must not stop the retention, and neither may break the budget check. */
export async function runFeedbackCron(now: Date = new Date()): Promise<FeedbackCronResult> {
  const out: FeedbackCronResult = { delivered: 0, attempted: 0, stopped: false, screenshotsPurged: 0, rowsDeleted: 0 };
  try {
    Object.assign(out, await deliverDueFeedback(now));
  } catch (error) {
    await logEvent({ event: "cron.feedback_delivery_failed", level: "error", route: "cron:budget-check", props: { error: error instanceof Error ? error.name : "unknown" } });
  }
  try {
    Object.assign(out, await runFeedbackRetention(now));
  } catch (error) {
    await logEvent({ event: "cron.feedback_retention_failed", level: "error", route: "cron:budget-check", props: { error: error instanceof Error ? error.name : "unknown" } });
  }
  await logEvent({ event: "cron.feedback", route: "cron:budget-check", props: { ...out } });
  return out;
}
