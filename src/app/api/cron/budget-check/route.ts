import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/server/admin/cron-auth";
import { runBudgetCheck } from "@/lib/server/admin/budget-run";
import { logEvent } from "@/lib/server/events";
import { runFeedbackCron } from "@/lib/server/feedback/cron";

// Daily Vercel Cron (vercel.json). Checks budgets, sends alerts (app_events + Sentry) and, through its DB reads,
// keeps the Supabase Free project active. Protected by CRON_SECRET; Vercel sends it as a Bearer token.
export const dynamic = "force-dynamic";
export const maxDuration = 120; // budget check plus up to 10 GitHub calls (10 s timeout each)

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (!isCronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new NextResponse(null, { status: 401, headers: noStore });
  }
  try {
    // Feedback first (never throws), so an auth failure of this run is already in app_events when the budget check
    // evaluates the `feedback_delivery` alert.
    const feedback = await runFeedbackCron();
    const result = await runBudgetCheck();
    return NextResponse.json({ ok: true, ...result, feedback }, { headers: noStore });
  } catch (error) {
    await logEvent({ event: "cron.budget_check_failed", level: "error", route: "cron:budget-check", props: { error: error instanceof Error ? error.name : "unknown" } });
    return NextResponse.json({ ok: false }, { status: 500, headers: noStore });
  }
}
