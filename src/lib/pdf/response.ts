import "server-only";
import type { PlanDocument } from "@/lib/domain/share";
import { logEvent } from "@/lib/server/events";
import { pdfFileName } from "./filename";
import { renderPlanPdf } from "./render";

export function pdfHeaders(fileName: string, bytes: number): Record<string, string> {
  return {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Content-Length": String(bytes),
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex",
    "Referrer-Policy": "no-referrer",
  };
}

/** Renders the document and logs `pdf.generated` (metadata only). Throws on render failure. */
export async function pdfResponse(doc: PlanDocument, via: "owner" | "share", userId?: string): Promise<Response> {
  const t0 = Date.now();
  const buf = await renderPlanPdf(doc);
  await logEvent({
    event: "pdf.generated",
    userId: userId ?? null,
    route: via === "owner" ? "/api/trips/[id]/pdf" : "/api/share/[token]/pdf",
    props: { via, days: doc.plan.days.length, items: doc.items?.length ?? 0, bytes: buf.length, ms: Date.now() - t0 },
  });
  return new Response(new Uint8Array(buf), { status: 200, headers: pdfHeaders(pdfFileName(doc.plan), buf.length) });
}
