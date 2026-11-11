/**
 * Why a patch changed nothing (port-places section 5, [P9]): the first notice that applies, decided by code from the
 * stored input, never from the model's reply. The client maps `code` to a message; the stop names are the user's own
 * input shown back to them (events carry the code only). Pure.
 */
import type { Plan } from "@/lib/domain/plan";
import type { PlanInputStored } from "./input";
import { placeMatches } from "./place-match";
import { stopsToRetry } from "./stops-input";

export const NOTICE_CODES = ["places_not_loadable", "stops_not_found", "stops_unchecked", "stops_capped", "stops_unknown"] as const;
export type NoticeCode = (typeof NOTICE_CODES)[number];
/** `places`: up to MAX_NOTICE_PLACES stop names (empty for codes without stops). */
export type PatchNotice = { code: NoticeCode; places: string[] };

export const MAX_NOTICE_PLACES = 3;

type Stops = NonNullable<PlanInputStored["llm"]["stopPlaces"]>;

/** Stops with a row on one of `days` (every day when none are selected). */
function inScope(stored: Pick<PlanInputStored, "llm">, days: readonly number[]): Stops {
  const rows = stored.llm.trip?.stops ?? [];
  return (stored.llm.stopPlaces ?? []).filter((p) => !days.length || rows.some((r) => r.at === p.id && days.includes(r.day)));
}

const names = (xs: Stops) => xs.slice(0, MAX_NOTICE_PLACES).map((p) => p.name);

/**
 * The base plan has a scheduled stop (a fixed window) at a place other than the destination while the trip has no
 * stops the app knows: the user typed the schedule in the notes only. Region and sub-area names of an ordinary trip
 * have no fixed window, so they never trigger this.
 */
export function hasUnknownSchedule(base: Plan, scopeDays: readonly number[], destinationNames: readonly string[]): boolean {
  return base.days
    .filter((d) => !scopeDays.length || scopeDays.includes(d.n))
    .some((d) => d.stops.some((s) => s.fixed === true && !destinationNames.some((n) => n && placeMatches(s.place, n))));
}

/**
 * Notice for a patch that changed nothing, `null` = none (the client shows "nothing changed" and the model's reply).
 * Order: 2 not found, 3 unchecked (after the retry), 4 capped, 5 no stops known. (1, `places_not_loadable`, is decided
 * where `needPlacesUnusable` is known.) `stored` is the input after the upgrade and retry of the patch.
 */
export function patchNotice(a: {
  stored: Pick<PlanInputStored, "llm" | "stopPoints">;
  scopeDays: readonly number[];
  /** `tripStops(trip)` is not empty. */
  tripHasStops: boolean;
  base: Plan;
  destinationNames: readonly string[];
}): PatchNotice | null {
  const scoped = inScope(a.stored, a.scopeDays);
  const notFound = scoped.filter((p) => p.s === "not_found");
  if (notFound.length) return { code: "stops_not_found", places: names(notFound) };
  const retry = new Set(stopsToRetry(a.stored, a.scopeDays));
  const unchecked = scoped.filter((p) => p.s === "error" || p.s === "skipped" || retry.has(p.id));
  if (unchecked.length) return { code: "stops_unchecked", places: names(unchecked) };
  const capped = scoped.filter((p) => p.s === "cap");
  if (capped.length) return { code: "stops_capped", places: names(capped) };
  if (!a.tripHasStops && hasUnknownSchedule(a.base, a.scopeDays, a.destinationNames)) return { code: "stops_unknown", places: [] };
  return null;
}
