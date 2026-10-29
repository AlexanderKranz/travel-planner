import { NextResponse } from "next/server";
import { checkDb } from "@/lib/server/health";

// Pinged by the uptime monitor every 5 minutes. The DB check goes through the
// Data API into Postgres, which also keeps the Supabase Free project awake.
// Provider checks are added as integrations land (docs/architecture.md).
export const dynamic = "force-dynamic";

export async function GET() {
  const db = await checkDb();
  return NextResponse.json(
    {
      status: db.ok ? "ok" : "degraded",
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      checks: { db },
    },
    { status: db.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
