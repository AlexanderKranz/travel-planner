import { NextResponse } from "next/server";
import { berlinToday } from "@/lib/date";
import { Locale } from "@/lib/domain";
import { getFlightsFacts } from "@/lib/server/facts/flights";
import { getProfile } from "@/lib/server/profile";
import { getPurpose } from "@/lib/server/purposes";
import { rateLimit } from "@/lib/server/rate-limit";
import { getUserSession } from "@/lib/server/session";
import { getTrip } from "@/lib/server/trips";

export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/trips/[id]/flights?locale=de -> Fact<FlightsFacts> (login required; the trip is read under RLS). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  const rl = rateLimit(`flights:${session.userId}`, 6, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

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

  const locale = Locale.catch("de").parse(new URL(request.url).searchParams.get("locale") ?? "de");
  const fact = await getFlightsFacts(trip, {
    homeAirports,
    purpose,
    ctx: { userId: session.userId, locale, today: berlinToday() },
    budgetMs: 25_000,
  });
  return NextResponse.json(fact, { headers: NO_STORE });
}
