"use server";

import { fail, type ActionResult } from "@/lib/domain/result";
import { FEEDBACK_BUCKET, FeedbackKind, FeedbackStatus, parseFeedbackRef, type FeedbackLookup, type FeedbackStats } from "@/lib/domain/feedback";
import { z } from "zod";
import { logEvent } from "../events";
import { rateLimit } from "../rate-limit";
import { createSupabaseAdminClient } from "../supabase/admin";
import { readFeedbackStats } from "./feedback-stats";
import { requireAdmin, getAdminSession } from "./gate";

const SIGNED_URL_SECONDS = 300;

/**
 * Admin feedback aggregates (D14). Admin check first (non-admins get the 404 page); no parameters, so a client cannot
 * pick the clock. The reads are in feedback-stats.ts.
 */
export async function getFeedbackStats(): Promise<FeedbackStats> {
  await requireAdmin();
  return readFeedbackStats(new Date());
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
  // A failed Auth or Storage read must not look like "no email" or "no screenshot".
  if (user.error || signed?.error) return fail("failed");
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
