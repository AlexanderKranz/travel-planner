import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { getSupabasePublicEnv } from "@/lib/supabase/env";

// Pinged by the uptime monitor every 5 minutes. The DB check goes through the
// Data API into Postgres, which also keeps the Supabase Free project awake.
// Provider checks are added as integrations land (docs/architecture.md).
export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 3000;

async function checkDb(): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();
  try {
    const { url, publishableKey } = getSupabasePublicEnv();
    // Publishable key only, no user session: public.health_check() reads no table.
    const supabase = createClient(url, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await supabase
      .rpc("health_check")
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    return { ok: !error, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  }
}

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
