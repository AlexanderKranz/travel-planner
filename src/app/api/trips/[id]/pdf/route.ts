import { NextResponse } from "next/server";
import { z } from "zod";
import { logEvent } from "@/lib/server/events";
import { getOwnerPlanDocument } from "@/lib/server/plan-document";
import { rateLimit } from "@/lib/server/rate-limit";
import { getUserSession } from "@/lib/server/session";
import { pdfResponse } from "@/lib/pdf/response";

export const runtime = "nodejs";
export const maxDuration = 30;

const Id = z.string().uuid();
const JSON_HEADERS = { "Cache-Control": "private, no-store" };

/** GET /api/trips/[id]/pdf: the owner's latest plan version as PDF (login required, RLS). */
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

  // Owner read goes through the RLS session (see plan-document.ts); null = not found or no plan yet.
  const doc = await getOwnerPlanDocument(id);
  if (!doc) return NextResponse.json({ error: "no_plan" }, { status: 409, headers: JSON_HEADERS });

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
