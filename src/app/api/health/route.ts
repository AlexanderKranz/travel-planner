import { NextResponse } from "next/server";
import { clientIp } from "@/lib/server/client-ip";
import { checkDb } from "@/lib/server/health";
import { rateLimit } from "@/lib/server/rate-limit";

// Pinged by the uptime monitor every 5 minutes. The DB check goes through the
// Data API into Postgres, which also keeps the Supabase Free project awake.
// Provider checks are added as integrations land (docs/architecture.md).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Public and touches the database: per-IP limit (a monitor pings every 5 minutes, so 30/min is generous).
  const ip = clientIp(request.headers);
  if (ip && !rateLimit(`health:${ip}`, 30, 60_000).ok) {
    return NextResponse.json({ status: "rate_limited" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });
  }
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
