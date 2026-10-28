import { NextResponse } from "next/server";
import { berlinToday } from "@/lib/date";
import { Locale } from "@/lib/domain";
import { getPlacesFacts, PLACES_REQUEST_BUDGET_MS } from "@/lib/server/facts/places";
import { getPurpose } from "@/lib/server/purposes";
import { rateLimit } from "@/lib/server/rate-limit";
import { getUserSession } from "@/lib/server/session";
import { getTrip } from "@/lib/server/trips";

// Vercel Hobby with Fluid compute: default and maximum are 300 s. Overpass needs up to ~1-2 minutes per query.
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };

/** GET /api/trips/[id]/places?locale=de -> Fact<PlacesFacts> (login required; the trip is read under RLS). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  // Reloads and retry clicks only; cached interests answer instantly. In-memory per instance (see rate-limit.ts).
  const rl = rateLimit(`places:${session.userId}`, 12, 60_000);
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

  const locale = Locale.catch("de").parse(new URL(request.url).searchParams.get("locale") ?? "de");
  const fact = await getPlacesFacts(
    trip,
    purpose,
    { userId: session.userId, locale, today: berlinToday() },
    { budgetMs: PLACES_REQUEST_BUDGET_MS },
  );
  return NextResponse.json(fact, { headers: NO_STORE });
}
