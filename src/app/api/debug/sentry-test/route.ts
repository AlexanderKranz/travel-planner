import { NextResponse } from "next/server";

// Verification helper for Sentry (docs/runbook.md). Throws on purpose, but ONLY
// when SENTRY_TEST_ENABLED is exactly "true"; otherwise it looks like a missing page.
export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.SENTRY_TEST_ENABLED !== "true") {
    return new NextResponse(null, { status: 404 });
  }
  throw new Error("Sentry test error (intentional, /api/debug/sentry-test)");
}
