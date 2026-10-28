import { NextResponse } from "next/server";
import { z } from "zod";
import { searchPlaces } from "@/lib/integrations/open-meteo-geocoding";
import { rateLimit } from "@/lib/server/rate-limit";
import { getUserSession } from "@/lib/server/session";

const querySchema = z.object({
  q: z.string().trim().min(2).max(80),
  lang: z.enum(["de", "en"]).default("en"),
});

/** GET /api/geocode?q=mar&lang=de -> { results: GeoPlace[] } (login required, proxies an external API). */
export async function GET(request: Request) {
  const session = await getUserSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // ~30 lookups per minute per user (in-memory per instance, see rate-limit.ts).
  const rl = rateLimit(`geocode:${session.userId}`, 30, 60_000);
  if (!rl.ok) {
    return NextResponse.json(
      { results: [], error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const params = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) return NextResponse.json({ error: "invalid_query" }, { status: 400 });

  try {
    const results = (await searchPlaces(parsed.data.q, parsed.data.lang, { userId: session.userId })).slice(0, 8);
    return NextResponse.json({ results }, { headers: { "Cache-Control": "private, max-age=3600" } });
  } catch {
    return NextResponse.json({ results: [], error: "unavailable" });
  }
}
