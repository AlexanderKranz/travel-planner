import "server-only";
import { after } from "next/server";
import { berlinToday } from "@/lib/date";
import type { Locale } from "@/lib/domain/profile";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { Trip } from "@/lib/domain/trip";
import { budgetAllows, getBudgetStatus, isAiEnabled, logAiUsage, type Role } from "./ai-usage";
import { warmTripFacts } from "./facts";
import { getPurpose } from "./purposes";
import { tagAndSave, wantsTags } from "./purpose-tagging";
import type { getUserSession } from "./session";
import { rowToTrip, TRIP_COLUMNS, type TripRow } from "./trip-mapping";
import { getEffectiveEnv } from "./settings";

type Session = NonNullable<Awaited<ReturnType<typeof getUserSession>>>;

/** Total time after() may spend warming facts (pages export maxDuration = 300). */
export const WARM_BUDGET_MS = 280_000;
/** Same reserve as the plan pipeline's tagging step. */
const RESERVE_TAGS = 2_000;

/**
 * Tags a free-text purpose before warming [D5]: the interests that decide which places are fetched (e.g. "golf"
 * from "Golftrip mit einem Freund") only exist after tagging. It is the same single Haiku call the plan pipeline
 * would make (cached by content hash), just earlier. Skipped when AI is off or the budget would not allow it.
 */
async function withTags(session: Session, purpose: TripPurpose | null): Promise<TripPurpose | null> {
  if (!wantsTags(purpose) || !isAiEnabled(await getEffectiveEnv())) return purpose;
  try {
    const { data } = await session.supabase.from("profiles").select("role, is_demo").eq("id", session.userId).maybeSingle();
    const role: Role = data?.role === "admin" ? "admin" : "user";
    const info = await getBudgetStatus(session.userId, role, data?.is_demo === true);
    if (!budgetAllows(info, RESERVE_TAGS)) return purpose;
    return await tagAndSave(session.userId, purpose, {
      onUsage: (u) => logAiUsage(session.userId, data?.is_demo === true, u),
    });
  } catch {
    return purpose;
  }
}

/**
 * Fire-and-forget cache warming after the response (never blocks or fails the action): purpose tags, then
 * weather/daylight/country/summary and places for every interest, so they are cached when the user clicks Generate.
 */
export async function scheduleTripWarm(session: Session, trip: Trip, locale: Locale): Promise<void> {
  try {
    after(async () => {
      try {
        let purpose: TripPurpose | null = null;
        if (trip.purposeId) {
          const res = await getPurpose(trip.purposeId);
          if (res.ok) purpose = res.data;
        }
        purpose = await withTags(session, purpose);
        await warmTripFacts(trip, purpose, { userId: session.userId, locale, today: berlinToday() }, { budgetMs: WARM_BUDGET_MS });
      } catch {
        // warming is best effort
      }
    });
  } catch {
    // after() unavailable (e.g. outside a request scope): skip
  }
}

/** Trips warmed after a purpose edit: the most recently updated ones using it. */
export const PURPOSE_WARM_TRIPS = 2;

/**
 * After a purpose edit: re-tag once, then warm places for the latest trips that use the purpose (sequentially,
 * one shared budget). Best effort, never throws.
 */
export async function schedulePurposeWarm(session: Session, purposeId: string): Promise<void> {
  try {
    after(async () => {
      try {
        const started = Date.now();
        const [{ data: profile }, { data: rows }, res] = await Promise.all([
          session.supabase.from("profiles").select("locale").eq("id", session.userId).maybeSingle(),
          session.supabase
            .from("trips")
            .select(TRIP_COLUMNS)
            .eq("purpose_id", purposeId)
            .order("updated_at", { ascending: false })
            .limit(PURPOSE_WARM_TRIPS)
            .returns<TripRow[]>(),
          getPurpose(purposeId),
        ]);
        if (!res.ok || !rows?.length) return;
        const locale: Locale = profile?.locale === "en" ? "en" : "de";
        const purpose = await withTags(session, res.data);
        for (const row of rows) {
          const left = WARM_BUDGET_MS - (Date.now() - started);
          if (left < 30_000) break;
          await warmTripFacts(rowToTrip(row), purpose, { userId: session.userId, locale, today: berlinToday() }, { budgetMs: left });
        }
      } catch {
        // warming is best effort
      }
    });
  } catch {
    // after() unavailable: skip
  }
}
