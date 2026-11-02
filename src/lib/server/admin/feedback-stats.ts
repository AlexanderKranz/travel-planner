import "server-only";
import { z } from "zod";
import type { FeedbackStats } from "@/lib/domain/feedback";
import { berlinMidnight } from "../ai-usage";
import { createSupabaseAdminClient } from "../supabase/admin";

const STATS_DAYS = 14;

const berlinDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * Aggregates for the admin page (D14): issues per Berlin day for 14 days, pending and failed counts, the last delivery
 * error class. Counts only. CALLERS MUST CHECK ADMIN FIRST. Secret key because `feedback` has no admin policy (D10).
 */
export async function readFeedbackStats(now: Date): Promise<FeedbackStats> {
  const admin = createSupabaseAdminClient();
  const count = async (q: PromiseLike<{ count: number | null; error: unknown }>) => {
    const { count: n, error } = await q;
    if (error) throw new Error("feedback stats read failed");
    return n ?? 0;
  };
  const days = Array.from({ length: STATS_DAYS }, (_, i) => {
    const from = berlinMidnight(now, i - (STATS_DAYS - 1));
    const to = berlinMidnight(now, i - (STATS_DAYS - 2));
    return { from, to };
  });
  const [perDay, pending, failed, last] = await Promise.all([
    Promise.all(
      days.map((d) =>
        count(
          admin
            .from("feedback")
            .select("id", { count: "exact", head: true })
            .eq("status", "created")
            .gte("issue_created_at", d.from.toISOString())
            .lt("issue_created_at", d.to.toISOString()),
        ),
      ),
    ),
    count(admin.from("feedback").select("id", { count: "exact", head: true }).eq("status", "pending")),
    count(admin.from("feedback").select("id", { count: "exact", head: true }).eq("status", "failed")),
    admin.from("feedback").select("last_error, updated_at").not("last_error", "is", null).order("updated_at", { ascending: false }).limit(1),
  ]);
  if (last.error) throw new Error("feedback stats read failed");
  const lastRow = z.object({ last_error: z.string(), updated_at: z.string() }).safeParse(last.data?.[0]);
  return {
    issuesPerDay: days.map((d, i) => ({ day: berlinDay.format(d.from), count: perDay[i] })),
    pending,
    failed,
    lastError: lastRow.success ? { errorClass: lastRow.data.last_error, at: lastRow.data.updated_at } : null,
  };
}

