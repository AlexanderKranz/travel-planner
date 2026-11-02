"use server";

import { fail, type ActionResult } from "@/lib/domain/result";
import { FEEDBACK_BUCKET, FeedbackKind, FeedbackStatus, parseFeedbackRef, type FeedbackLookup, type FeedbackStats } from "@/lib/domain/feedback";
import { z } from "zod";
import { berlinMidnight } from "../ai-usage";
import { logEvent } from "../events";
import { rateLimit } from "../rate-limit";
import { createSupabaseAdminClient } from "../supabase/admin";
import { requireAdmin, getAdminSession } from "./gate";

const SIGNED_URL_SECONDS = 300;
const STATS_DAYS = 14;

const berlinDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * Admin feedback aggregates (D14): issues per Berlin day for 14 days, pending and failed counts, the last delivery
 * error class. Counts only, no identifiers, no text. Admin check first (non-admins get the 404 page); the reads use
 * the secret key because `feedback` has no admin policy (D10).
 */
export async function getFeedbackStats(now: Date = new Date()): Promise<FeedbackStats> {
  await requireAdmin();
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

const Row = z.object({
  owner_id: z.string().uuid(),
  created_at: z.string(),
  kind: FeedbackKind,
  status: FeedbackStatus,
  issue_url: z.string().nullable(),
  screenshot_path: z.string().nullable(),
});

/**
 * Reference lookup (D3/D14): the reporter's email, date, type, status, issue link and a 5-minute signed screenshot URL.
 * Nothing else of the user. Every lookup is audited as `admin.feedback_lookup` with the reference only (never the
 * email or the screenshot). An unknown and a malformed reference give the same answer (`not_found`).
 */
export async function lookupFeedbackRef(input: unknown): Promise<ActionResult<FeedbackLookup>> {
  const session = await getAdminSession();
  if (!session) return fail("forbidden");
  if (!rateLimit(`feedback-lookup:${session.userId}`, 30, 60_000).ok) return fail("rate_limited");

  const ref = parseFeedbackRef(input);
  // The audit holds the opaque reference only; a malformed input (could be anything) is not logged.
  await logEvent({ event: "admin.feedback_lookup", userId: session.userId, route: "action:lookupFeedbackRef", props: { ref } });
  if (!ref) return fail("not_found");

  // Secret key on purpose (RLS bypass): feedback has no admin policy; admin check above.
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("feedback")
    .select("owner_id, created_at, kind, status, issue_url, screenshot_path")
    .eq("ref", ref)
    .maybeSingle();
  if (error) return fail("failed");
  const row = Row.safeParse(data);
  if (!row.success) return fail("not_found");

  const [user, signed] = await Promise.all([
    admin.auth.admin.getUserById(row.data.owner_id),
    row.data.screenshot_path
      ? admin.storage.from(FEEDBACK_BUCKET).createSignedUrl(row.data.screenshot_path, SIGNED_URL_SECONDS)
      : Promise.resolve(null),
  ]);
  return {
    ok: true,
    data: {
      ref,
      email: user.data?.user?.email ?? null,
      createdAt: row.data.created_at,
      kind: row.data.kind,
      status: row.data.status,
      issueUrl: row.data.issue_url,
      screenshotUrl: signed?.data?.signedUrl ?? null,
    },
  };
}
