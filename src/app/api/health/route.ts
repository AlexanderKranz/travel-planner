import { NextResponse } from "next/server";

// Pinged by the uptime monitor. Provider and DB checks are added as those
// integrations land (see "Admin area & monitoring" in docs/architecture.md).
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
    checks: {},
  });
}
