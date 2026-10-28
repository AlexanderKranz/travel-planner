import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { pdfResponse } from "@/lib/pdf/response";
import { logEvent } from "@/lib/server/events";
import { clientIp } from "@/lib/server/client-ip";
import { getSharedPlanDocument } from "@/lib/server/plan-document";
import { rateLimit } from "@/lib/server/rate-limit";
import { isShareTokenFormat } from "@/lib/server/share-token";

export const runtime = "nodejs";
export const maxDuration = 30;

const H = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" };
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404, headers: H });

function limited(retryAfter: number) {
  return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { ...H, "Retry-After": String(retryAfter) } });
}

/**
 * GET /api/share/[token]/pdf: public, read-only. No session; the token is the credential.
 * getSharedPlanDocument uses the admin client (explicit columns) and already applies include_items /
 * include_item_notes, so the PDF renders exactly what the share page shows. Every miss is the same 404.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isShareTokenFormat(token)) return notFound();

  // IP is used only as an in-memory rate-limit key; never stored or logged.
  // Without an IP only the per-token limit applies (no shared "unknown" bucket).
  const ip = clientIp(request.headers);
  const byIp = ip ? rateLimit(`share-pdf-ip:${ip}`, 6, 60_000) : null;
  if (byIp && !byIp.ok) return limited(byIp.retryAfterSeconds);
  const byTok = rateLimit(`share-tok:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`, 120, 60_000);
  if (!byTok.ok) return limited(byTok.retryAfterSeconds);

  const doc = await getSharedPlanDocument(token, "pdf");
  if (!doc) return notFound();

  try {
    return await pdfResponse(doc, "share");
  } catch (e) {
    await logEvent({
      event: "pdf.failed",
      level: "error",
      route: "/api/share/[token]/pdf",
      props: { via: "share", code: e instanceof Error ? e.name : "unknown" },
    });
    return NextResponse.json({ error: "failed" }, { status: 500, headers: H });
  }
}
