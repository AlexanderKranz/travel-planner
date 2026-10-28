import { NextResponse } from "next/server";
import { z } from "zod";
import { berlinToday } from "@/lib/date";
import { Locale } from "@/lib/domain";
import { IataCode } from "@/lib/domain/flights";
import { getNearbyFlights } from "@/lib/server/facts/flights-nearby";
import { getProfile } from "@/lib/server/profile";
import { getPurpose } from "@/lib/server/purposes";
import { rateLimit } from "@/lib/server/rate-limit";
import { getUserSession } from "@/lib/server/session";
import { getTrip } from "@/lib/server/trips";

export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };
const Query = z.object({ dir: z.enum(["out", "back"]), from: IataCode, to: IataCode });

/**
 * GET /api/trips/[id]/flights/nearby?dir=out&from=FRA&to=PMI&locale=de -> Fact<NearbyFlights>
 * Day before / after the trip date for one pair and direction (<= 8 units cold; cached days are free).
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  const rl = rateLimit(`flights-nearby:${session.userId}`, 6, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const url = new URL(request.url);
  const q = Query.safeParse({
    dir: url.searchParams.get("dir"),
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
  });
  if (!q.success) return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });

  const { id } = await params;
  const tripRes = await getTrip(id);
  if (!tripRes.ok) {
    const notFound = tripRes.error === "not_found" || tripRes.error === "invalid";
    return NextResponse.json(
      { error: notFound ? "not_found" : "failed" },
      { status: notFound ? 404 : 500, headers: NO_STORE },
    );
  }
  const trip = tripRes.data;
  let purpose = null;
  if (trip.purposeId) {
    const p = await getPurpose(trip.purposeId);
    if (p.ok) purpose = p.data;
  }
  const profile = await getProfile();
  const homeAirports = profile.ok ? profile.data.homeAirports : [];

  const locale = Locale.catch("de").parse(url.searchParams.get("locale") ?? "de");
  const fact = await getNearbyFlights(trip, q.data, {
    homeAirports,
    purpose,
    ctx: { userId: session.userId, locale, today: berlinToday() },
    budgetMs: 25_000,
  });
  if (fact.status === "invalid") return NextResponse.json({ error: "invalid" }, { status: 400, headers: NO_STORE });
  return NextResponse.json(fact, { headers: NO_STORE });
}
