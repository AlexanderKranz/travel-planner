import { NextResponse } from "next/server";
import { z } from "zod";
import { logEvent } from "@/lib/server/events";
import { getOwnerPlanDocumentResult } from "@/lib/server/plan-document";
import { rateLimit } from "@/lib/server/rate-limit";
import { getUserSession } from "@/lib/server/session";
import { pdfResponse } from "@/lib/pdf/response";

export const runtime = "nodejs";
export const maxDuration = 30;

const Id = z.string().uuid();
const JSON_HEADERS = { "Cache-Control": "private, no-store" };

/**
 * GET /api/trips/[id]/pdf: the latest plan version as PDF (login required, RLS). Every access level may download it: the
 * owner, a write grantee and a read grantee of a shared trip (sharing spec 1.1); RLS already limits what is read, so a
 * trip the user cannot see (a stranger, an unknown id, a disabled owner) answers 404 and a trip without a plan 409.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers: JSON_HEADERS });
  if (!Id.safeParse(id).success) return NextResponse.json({ error: "not_found" }, { status: 404, headers: JSON_HEADERS });

  const rl = rateLimit(`pdf:${session.userId}`, 10, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...JSON_HEADERS, "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  // The read goes through the RLS session (see plan-document.ts). No access check beyond a visible trip is needed.
  const res = await getOwnerPlanDocumentResult(id);
  if (!res.ok) {
    if (res.error === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404, headers: JSON_HEADERS });
    if (res.error === "no_plan") return NextResponse.json({ error: "no_plan" }, { status: 409, headers: JSON_HEADERS });
    return NextResponse.json({ error: res.error === "unauthenticated" ? "unauthenticated" : "failed" }, { status: res.error === "unauthenticated" ? 401 : 500, headers: JSON_HEADERS });
  }
  const doc = res.doc;

  try {
    return await pdfResponse(doc, "owner", session.userId);
  } catch (e) {
    console.error("pdf.failed", e); // full stack in the Vercel function log
    await logEvent({
      event: "pdf.failed",
      level: "error",
      userId: session.userId,
      route: "/api/trips/[id]/pdf",
      props: { via: "owner", code: e instanceof Error ? e.name : "unknown", message: e instanceof Error ? e.message.slice(0, 300) : null },
    });
    return NextResponse.json({ error: "failed" }, { status: 500, headers: JSON_HEADERS });
  }
}
