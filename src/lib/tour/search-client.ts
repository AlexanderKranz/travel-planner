import type { TourSuggestion } from "@/lib/domain/tour";

/** Spec 3.1: debounced 400 ms, at least 3 characters (the route caps results at 8). */
export const PLACE_SEARCH_DEBOUNCE_MS = 400;
export const PLACE_SEARCH_MIN_CHARS = 3;

export type PlaceSearchAnswer = { items: TourSuggestion[]; status: "ok" | "unavailable" | "rate_limited" | "daily_limit" };

/** Browser call to /api/places/search (login required). Throws on transport errors and AbortError. */
export async function searchPlaces(
  q: string,
  centre: { lat: number; lon: number },
  lang: string,
  signal: AbortSignal,
): Promise<PlaceSearchAnswer> {
  const params = new URLSearchParams({ q, lat: centre.lat.toFixed(5), lon: centre.lon.toFixed(5), lang });
  const res = await fetch(`/api/places/search?${params.toString()}`, { signal });
  const body = (await res.json().catch(() => ({}))) as { results?: TourSuggestion[]; error?: string };
  if (res.status === 429) return { items: [], status: body.error === "daily_limit" ? "daily_limit" : "rate_limited" };
  if (res.status === 400) return { items: [], status: "ok" };
  if (!res.ok || body.error) return { items: [], status: "unavailable" };
  return { items: body.results ?? [], status: "ok" };
}
