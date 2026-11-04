import "server-only";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { FeedbackKind, issueBody, issueTitle } from "@/lib/domain/feedback";
import { createIssue, findIssueByRef, githubConfig, type GithubFailure, type GithubIssue, type GithubResult } from "@/lib/integrations/github";
import { logEvent } from "../events";
import { getSetting } from "../settings";
import { createSupabaseAdminClient } from "../supabase/admin";

/**
 * Creates the GitHub issue for one saved report (spec D6). Shared by `after()` in POST /api/feedback and the daily cron.
 * The row is leased through `feedback_claim(id, ceiling)` (atomic, enforces the app-wide daily ceiling); every outcome
 * clears `lease_until`, so a back-off (`next_attempt_at`) never counts against the ceiling, only a live lease does.
 * Never throws; never logs the report text.
 */

export const MAX_ATTEMPTS = 8;
const BACKOFF_MS = 3_600_000;

export type DeliverOutcome = "created" | "linked" | "not_claimed" | "no_token" | "backoff" | "failed" | "rate_limited" | "auth_failed";
/** `stop` = GitHub told us to stop for now (rate limit or auth): the cron ends its run. */
export type DeliverResult = { outcome: DeliverOutcome; stop: boolean };

const ClaimedRow = z.object({
  id: z.string().uuid(),
  ref: z.string(),
  kind: FeedbackKind,
  body: z.string().nullable(),
  page_path: z.string().nullable(),
  app_version: z.string(),
  client: z.string().nullable(),
  screenshot_path: z.string().nullable(),
  attempts: z.number().int(),
});
type Claimed = z.infer<typeof ClaimedRow>;

const iso = (d: Date) => d.toISOString();

export async function deliverFeedback(id: string, opts: { userId?: string | null; now?: Date } = {}): Promise<DeliverResult> {
  const now = opts.now ?? new Date();
  // Without a token nothing is claimed: the attempt counter and the lease stay untouched and the row stays pending.
  if (!githubConfig()) return { outcome: "no_token", stop: false };
  try {
    return await run(id, opts.userId ?? null, now);
  } catch (error) {
    console.error("feedback delivery failed", error instanceof Error ? error.name : "unknown");
    return { outcome: "backoff", stop: false }; // the 10-minute lease expires by itself
  }
}

async function run(id: string, userId: string | null, now: Date): Promise<DeliverResult> {
  // Secret key on purpose (RLS bypass): feedback has no user write grants (spec D10); server-only delivery.
  const admin = createSupabaseAdminClient();
  const ceiling = Number((await getSetting("feedback_daily_issues")).value);
  const { data, error } = await admin.rpc("feedback_claim", { p_id: id, p_ceiling: ceiling });
  if (error) {
    await logEvent({ event: "feedback.delivery_failed", level: "warn", userId, props: { status: "claim_error" } });
    return { outcome: "not_claimed", stop: false };
  }
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  if (rows.length === 0) {
    // Not due, already leased by another attempt, or the ceiling is reached: the cron picks it up later.
    await logEvent({ event: "feedback.deferred", userId, props: { ceiling } });
    return { outcome: "not_claimed", stop: false };
  }
  const parsed = ClaimedRow.safeParse(rows[0]);
  if (!parsed.success) {
    // The attempt counts (already incremented by the claim), so the row reaches `failed` at the 8th instead of 20.
    const n = Number((rows[0] as { attempts?: unknown })?.attempts);
    const last = Number.isFinite(n) && n >= MAX_ATTEMPTS;
    await settle(id, {
      lease_until: null,
      last_error: "bad_row",
      ...(last ? { status: "failed" } : { next_attempt_at: iso(new Date(now.getTime() + BACKOFF_MS)) }),
    });
    await logEvent({ event: "feedback.delivery_failed", level: "warn", userId, props: { status: "bad_row" } });
    return { outcome: last ? "failed" : "backoff", stop: false };
  }
  const row = parsed.data;
  if (!row.body) {
    // Nothing left to publish (cannot happen for a pending row); close it instead of retrying forever.
    await settle(id, { lease_until: null, status: "failed", last_error: "no_body" });
    return { outcome: "failed", stop: false };
  }

  let issue: GithubResult<GithubIssue>;
  let linked = false;
  if (row.attempts > 1) {
    // An earlier try may have created the issue without us recording it.
    const found = await findIssueByRef(row.ref, { userId, now });
    if (found.kind === "ok" && found.value) {
      issue = { kind: "ok", value: found.value };
      linked = true;
    } else if (found.kind === "ok") issue = await create(row, userId, now);
    else issue = found;
  } else issue = await create(row, userId, now);

  return finish(row, issue, linked, userId, now);
}

function create(row: Claimed, userId: string | null, now: Date) {
  const text = row.body ?? "";
  return createIssue(
    {
      title: issueTitle(row.ref, row.kind, text),
      body: issueBody({ ref: row.ref, kind: row.kind, pagePath: row.page_path, appVersion: row.app_version, client: row.client, hasScreenshot: !!row.screenshot_path, text }),
      kind: row.kind,
    },
    { userId, now },
  );
}

async function finish(row: Claimed, r: GithubResult<GithubIssue>, linked: boolean, userId: string | null, now: Date): Promise<DeliverResult> {
  if (r.kind === "ok") {
    await settle(row.id, {
      status: "created",
      issue_number: r.value.number,
      issue_url: r.value.url,
      issue_created_at: iso(now),
      body: null,
      lease_until: null,
      last_error: null,
    });
    await logEvent({ event: "feedback.issue_created", userId, props: { issue_number: r.value.number, linked } });
    await notifyOwner(row, r.value);
    return { outcome: linked ? "linked" : "created", stop: false };
  }
  return fail(row, r, userId, now);
}

/**
 * One email per new issue through a Sentry alert rule (runbook section 18): the issues are created with the owner's
 * token, so GitHub never notifies the owner. Reference, kind and issue only, never the text. The fingerprint makes
 * every report a NEW Sentry issue, which the "new issue" condition needs. A linked row also notifies: the try that
 * created the issue never settled, so it never notified. No-op without a DSN; never throws.
 */
async function notifyOwner(row: Claimed, issue: GithubIssue): Promise<void> {
  try {
    Sentry.captureMessage(`Feedback ${row.ref}: issue #${issue.number}`, {
      level: "info",
      tags: { feedback_issue: "true", feedback_kind: row.kind },
      extra: { ref: row.ref, issue_number: issue.number, issue_url: issue.url },
      fingerprint: ["feedback-issue", row.ref],
    });
    await Sentry.flush(2000);
  } catch {
    // Monitoring must not fail a delivery that already succeeded.
  }
}

async function fail(row: Claimed, r: GithubFailure, userId: string | null, now: Date): Promise<DeliverResult> {
  // A global stop is not this report's failure: the attempt is given back, so it does not count towards the 8.
  const giveBack = { attempts: Math.max(0, row.attempts - 1), lease_until: null };
  switch (r.kind) {
    case "not_configured":
      await settle(row.id, giveBack);
      return { outcome: "no_token", stop: true };
    case "rate_limited":
      await settle(row.id, { ...giveBack, next_attempt_at: iso(r.retryAt), last_error: "rate_limited" });
      await logEvent({ event: "feedback.delivery_failed", level: "warn", userId, props: { status: 429 } });
      return { outcome: "rate_limited", stop: true };
    case "auth":
      await settle(row.id, { ...giveBack, last_error: "auth" });
      await logEvent({ event: "feedback.github_auth_failed", level: "error", userId, props: {} });
      return { outcome: "auth_failed", stop: true };
    case "validation":
      await settle(row.id, { status: "failed", last_error: "validation", lease_until: null });
      await logEvent({ event: "feedback.delivery_failed", level: "warn", userId, props: { status: 422 } });
      return { outcome: "failed", stop: false };
    case "server": {
      const last = row.attempts >= MAX_ATTEMPTS;
      await settle(row.id, {
        lease_until: null,
        last_error: r.status === null ? "network" : "server_error",
        ...(last ? { status: "failed" } : { next_attempt_at: iso(new Date(now.getTime() + BACKOFF_MS)) }),
      });
      await logEvent({ event: "feedback.delivery_failed", level: "warn", userId, props: { status: r.status } });
      return { outcome: last ? "failed" : "backoff", stop: false };
    }
  }
}

async function settle(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await createSupabaseAdminClient().from("feedback").update(patch).eq("id", id);
  if (error) {
    // The issue may exist without a record: the duplicate guard (search by reference) handles the next attempt.
    console.error("feedback settle failed", error.code);
    await logEvent({ event: "feedback.delivery_failed", level: "error", props: { status: "settle_error" } });
  }
}
