import { DROP_REASONS, type DropCounts, type SearchDrops, type SuggestionCard, type TravelMode } from "@/lib/domain/destination-search";
import { roundedDriveMin } from "@/lib/drive/estimate";
import { roundedHalfHourMin } from "@/lib/flights/estimate";

/** Poll the running search this often, and give up (with a "check again" button) after this long. */
export const POLL_INTERVAL_MS = 2_000;
export const POLL_GIVE_UP_MS = 4 * 60_000;
/** After this long the status text changes from "collecting ideas" to "checking places". */
export const CHECKING_AFTER_S = 8;

const BASE_LIMITS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8, 10, 12, 15];

/** Flight limit choices in hours (1 to 15, half hours); a default outside the list (a purpose with 9 h) is added. */
export function limitOptions(...extra: (number | null)[]): number[] {
  const all = new Set([...BASE_LIMITS, ...extra.filter((h): h is number => h !== null)]);
  return [...all].sort((a, b) => a - b);
}

/** The limit a purpose brings along, as hours on the half-hour grid the API accepts; null = none. */
export function defaultLimitHours(maxBlockMin: number | null): number | null {
  if (maxBlockMin === null) return null;
  const h = Math.round((maxBlockMin / 60) * 2) / 2;
  return h >= 1 && h <= 15 ? h : null;
}

/** Hours of a rounded flight estimate for the card: 90 min -> 1.5, 120 min -> 2. */
export const flightHours = (minutes: number): number => roundedHalfHourMin(minutes) / 60;

/** Hours of a rounded drive for the card: 210 min -> 3.5; a card never shows more than the limit (limit + 10 min rounds down). */
export const driveHours = (minutes: number): number => roundedDriveMin(minutes) / 60;

/** Default mode of the form (spec section 2): flight when the profile has airports, else drive when a usable home exists, else flight. */
export function defaultTravelMode(homeAirports: readonly string[], usableHome: unknown): TravelMode {
  return homeAirports.length > 0 ? "flight" : usableHome ? "drive" : "flight";
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Mean of the chosen months, rounded for display (the source rows stay unrounded). */
export function climateSummary(months: { tMaxC: number; tMinC: number; wetDays: number }[]): { high: number; low: number; wet: number } | null {
  if (months.length === 0) return null;
  return {
    high: Math.round(mean(months.map((m) => m.tMaxC))),
    low: Math.round(mean(months.map((m) => m.tMinC))),
    wet: Math.round(mean(months.map((m) => m.wetDays))),
  };
}

/** Drop counts of both rounds added up; only reasons that occurred, in a fixed order. */
export function dropTotals(drops: SearchDrops): [reason: (typeof DROP_REASONS)[number], count: number][] {
  const sum = (r: (typeof DROP_REASONS)[number]) => (["1", "2"] as const).reduce((n, k) => n + ((drops[k] as DropCounts | undefined)?.[r] ?? 0), 0);
  return DROP_REASONS.map((r) => [r, sum(r)] as [(typeof DROP_REASONS)[number], number]).filter(([, n]) => n > 0);
}

/** geoId -> trip id (see `tripsOfSearch`) for the cards that already have a trip made from this list. */
export const hasTrip = (card: Pick<SuggestionCard, "geoId">, byGeo: Record<string, string>): string | null => byGeo[String(card.geoId)] ?? null;
