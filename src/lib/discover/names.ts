import type { GeoPlace } from "@/lib/domain/geo";
import { haversineKm } from "@/lib/facts/places";

/** Accent-, case- and space-insensitive form for comparing place names ("Málaga" = "malaga"). */
export const foldName = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss").replace(/\s+/g, " ").trim();

/** Two places closer than this are the same suggestion (spec step 1, `duplicate`). */
export const DUPLICATE_KM = 30;

/**
 * Step 1 of the verification: the geocoding result that is the anchor town. Only populated places (PPL*) of the
 * stated country. An exact match on the folded name wins; failing that, a name that starts with the anchor
 * ("Palma" -> "Palma de Mallorca") counts, but only for administrative seats and capitals (PPLA*, PPLC), so a
 * hamlet that merely begins with the same letters cannot pass. On a tie the largest population. null = not found.
 */
export function pickAnchorPlace(results: GeoPlace[], anchor: string, cc: string): GeoPlace | null {
  const wanted = foldName(anchor);
  const country = cc.trim().toUpperCase();
  if (!wanted) return null;
  const inCountry = results.filter((p) => p.featureCode.startsWith("PPL") && p.countryCode?.toUpperCase() === country);
  const biggest = (xs: GeoPlace[]) => xs.reduce((best, p) => ((p.population ?? 0) > (best.population ?? 0) ? p : best));
  const exact = inCountry.filter((p) => foldName(p.name) === wanted);
  if (exact.length > 0) return biggest(exact);
  const prefix = inCountry.filter((p) => /^PPL[AC]/.test(p.featureCode) && foldName(p.name).startsWith(`${wanted} `));
  return prefix.length > 0 ? biggest(prefix) : null;
}

/**
 * `city` when the label is the anchor itself or the verified place name (so "Lissabon" for the anchor "Lisbon" is a
 * city), else `region` around the anchor town (spec [D8]).
 */
export const kindOf = (name: string, anchor: string, placeName?: string): "city" | "region" => {
  const n = foldName(name);
  return n === foldName(anchor) || (placeName !== undefined && n === foldName(placeName)) ? "city" : "region";
};

type Point = Pick<GeoPlace, "geoId" | "lat" | "lon">;
export function isDuplicate(p: Point, others: Point[]): boolean {
  return others.some((o) => o.geoId === p.geoId || haversineKm(o, p) < DUPLICATE_KM);
}
