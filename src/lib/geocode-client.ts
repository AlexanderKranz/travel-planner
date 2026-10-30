import type { GeoPlace } from "@/lib/domain";

/** Localized country name for an ISO code, falling back to the code. */
export function countryName(code: string | null, locale: string): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "Name, Region, Country" label of a geocoding result. */
export function placeLabel(p: GeoPlace, locale: string): string {
  return [p.name, p.admin1, countryName(p.countryCode, locale)].filter(Boolean).join(", ");
}

/** Browser call to /api/geocode (login required). Throws on transport errors. */
export async function geocode(q: string, lang: string, signal: AbortSignal) {
  const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}&lang=${lang}`, { signal });
  if (res.status === 429) return { results: [] as GeoPlace[], unavailable: false, rateLimited: true };
  if (!res.ok) throw new Error(String(res.status));
  const body = (await res.json()) as { results?: GeoPlace[]; error?: string };
  return {
    results: body.results ?? [],
    unavailable: body.error === "unavailable",
    rateLimited: body.error === "rate_limited",
  };
}
