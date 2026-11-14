import { NextResponse } from "next/server";
import { z } from "zod";
import { TourStopInfo } from "@/lib/domain/stop-info";
import { tourPdfResponse } from "@/lib/pdf/tour-response";
import { logEvent } from "@/lib/server/events";
import { getProfile } from "@/lib/server/profile";
import { rateLimit } from "@/lib/server/rate-limit";
import { getUserSession } from "@/lib/server/session";
import { getTour } from "@/lib/server/tours";

export const runtime = "nodejs";
export const maxDuration = 30;

const Id = z.string().uuid();
const JSON_HEADERS = { "Cache-Control": "private, no-store" };
const json = (error: string, status: number, extra: Record<string, string> = {}) =>
  NextResponse.json({ error }, { status, headers: { ...JSON_HEADERS, ...extra } });

/**
 * GET /api/tours/[id]/pdf[?stopInfo=1]: a city tour as PDF (login required, RLS). Every reader may download it: the
 * owner and anyone the tour or its trip is shared with. A tour the user cannot see answers 404, one without a result
 * 409. `stopInfo=1` adds the stored stop info (city-tour-stop-info 6); the PDF uses the viewer's language.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getUserSession();
  if (!session) return json("unauthenticated", 401);
  if (!Id.safeParse(id).success) return json("not_found", 404);
  const rl = rateLimit(`pdf:${session.userId}`, 10, 60_000);
  if (!rl.ok) return json("rate_limited", 429, { "Retry-After": String(rl.retryAfterSeconds) });

  const res = await getTour(id);
  if (!res.ok) return res.error === "not_found" || res.error === "invalid" ? json("not_found", 404) : json("failed", 500);
  const tour = res.data;
  if (!tour.result) return json("no_result", 409);

  let stopInfo: TourStopInfo | null = null;
  if (new URL(request.url).searchParams.get("stopInfo") === "1") {
    const { data } = await session.supabase.from("city_tours").select("stop_info").eq("id", id).maybeSingle<{ stop_info: unknown }>();
    const parsed = TourStopInfo.safeParse(data?.stop_info);
    stopInfo = parsed.success ? parsed.data : null;
  }
  const profile = await getProfile();
  const locale = profile.ok ? profile.data.locale : "de";
  try {
    return await tourPdfResponse(tour, locale, stopInfo, "owner", session.userId);
  } catch (e) {
    console.error("pdf.failed", e);
    await logEvent({ event: "pdf.failed", level: "error", userId: session.userId, props: { kind: "tour" } });
    return json("failed", 500);
  }
}
