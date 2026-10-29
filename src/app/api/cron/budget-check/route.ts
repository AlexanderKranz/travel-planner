import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/server/admin/cron-auth";
import { runBudgetCheck } from "@/lib/server/admin/budget-run";
import { logEvent } from "@/lib/server/events";

// Daily Vercel Cron (vercel.json). Checks budgets, sends alerts (app_events + Sentry) and, through its DB reads,
// keeps the Supabase Free project active. Protected by CRON_SECRET; Vercel sends it as a Bearer token.
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (!isCronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new NextResponse(null, { status: 401, headers: noStore });
  }
  try {
    const result = await runBudgetCheck();
    return NextResponse.json({ ok: true, ...result }, { headers: noStore });
  } catch (error) {
    await logEvent({ event: "cron.budget_check_failed", level: "error", route: "cron:budget-check", props: { error: error instanceof Error ? error.name : "unknown" } });
    return NextResponse.json({ ok: false }, { status: 500, headers: noStore });
  }
}
