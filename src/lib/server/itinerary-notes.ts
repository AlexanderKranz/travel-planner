import "server-only";
import { berlinToday } from "@/lib/date";
import type { ItineraryContext } from "@/lib/domain/itinerary";
import { canEdit } from "@/lib/domain/sharing";
import type { Trip } from "@/lib/domain/trip";
import type { DerivedStops } from "@/lib/domain/trip-stops";
import { derivableStops, mapStops } from "@/lib/itinerary/map";
import { parseItinerary } from "@/lib/itinerary/parse";
import { prefilterItinerary } from "@/lib/itinerary/prefilter";
import { itineraryHash } from "./ai/itinerary-extract";
import { logEvent } from "./events";
import { findExtract, runItineraryAi } from "./itinerary-ai";
import type { getUserSession } from "./session";

type Session = NonNullable<Awaited<ReturnType<typeof getUserSession>>>;

/** The trip context of the SAVED trip (notes derivation uses the saved dates, section 3.5). */
export function tripContext(trip: Pick<Trip, "timing" | "lengthDays">): ItineraryContext {
  return { startDate: trip.timing.kind === "date" ? trip.timing.startDate : null, lengthDays: trip.lengthDays };
}

/** Fewer kept lines than this: not worth a Haiku call ([D10]: "only when the prefilter keeps at least 2 lines"). */
const MIN_AI_LINES = 2;
/** Derived stops are used only with at least this many (fewer is a remark, not an itinerary). */
const MIN_STOPS = 2;

export type DeriveOptions = {
  /** Acting user; null = parser and cache only (no AI call can be charged). */
  session: Session | null;
  /** AI may be called (the actor can edit the trip). Read grantees and background work without a session: no. */
  allowAi: boolean;
  /** Injected in tests. */
  run?: typeof runItineraryAi;
  today?: string;
};

/**
 * Stops derived from the trip notes ([D10]): prefilter → parser (0 tokens) → the owner's cache → Haiku text path on a
 * parser miss. Never writes `trips.stops`. Stops outside the trip are dropped. Returns null when nothing usable was
 * derived (no notes, fewer than 2 stops, AI off or not allowed, limit or budget reached, error). Never throws.
 */
export async function deriveNotesStops(trip: Trip, opts: DeriveOptions): Promise<DerivedStops | null> {
  const notes = trip.notes;
  if (!notes?.trim()) return null;
  try {
    const ctx = tripContext(trip);
    const today = opts.today ?? berlinToday();
    const text = prefilterItinerary(notes);
    if (!text) return null;
    const parsed = parseItinerary(text, ctx, today);
    if (parsed.usable) return result(notes, derivableStops(parsed.stops));
    if (text.split("\n").length < MIN_AI_LINES) return null;

    const payload = { kind: "text" as const, text };
    const cached = await findExtract(trip.ownerId, itineraryHash(payload));
    if (cached) return result(notes, derivableStops(mapStops(cached.stops, ctx, today)));
    if (!opts.session || !opts.allowAi) return null;

    const run = await (opts.run ?? runItineraryAi)(opts.session, trip.ownerId, payload);
    if (!run.ok) return null;
    const stops = mapStops(run.extract.stops, ctx, today);
    if (!run.cached) {
      await logEvent({
        event: "itinerary.extracted",
        userId: opts.session.userId,
        props: { path: "text_ai", source: "notes", stops: stops.length, flagged: stops.filter((s) => s.flags.length > 0).length, pages: null },
      });
    }
    return result(notes, derivableStops(stops));
  } catch {
    return null;
  }
}

function result(notes: string, stops: DerivedStops["stops"]): DerivedStops | null {
  return stops.length >= MIN_STOPS ? { notes, stops } : null;
}

/** A deriver for `resolveTripStops` on behalf of `session` (AI allowed when the session can edit the trip). */
export function notesDeriver(session: Session | null) {
  return (trip: Trip) => deriveNotesStops(trip, { session, allowAi: session !== null && canEdit(trip.access) });
}
