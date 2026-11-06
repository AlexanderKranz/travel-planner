import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/server/admin/cron-auth";
import { logEvent } from "@/lib/server/events";
import { runPlaceRetries } from "@/lib/server/place-retries";

// Called every 5 minutes by pg_cron through pg_net (migration 20261111120036; Vercel Hobby crons run only daily).
// Retries place lookups that failed, for at most 30 minutes per search (spec activities addendum 2). Protected by
// CRON_SECRET as a Bearer token, like /api/cron/budget-check.
export const dynamic = "force-dynamic";
export const maxDuration = 300; // the run budget is 240 s

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (!isCronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new NextResponse(null, { status: 401, headers: noStore });
  }
  try {
    const summary = await runPlaceRetries();
    return NextResponse.json({ ok: true, ...summary }, { headers: noStore });
  } catch (error) {
    await logEvent({ event: "cron.place_retries_failed", level: "error", route: "cron:place-retries", props: { error: error instanceof Error ? error.name : "unknown" } });
    return NextResponse.json({ ok: false }, { status: 500, headers: noStore });
  }
}
