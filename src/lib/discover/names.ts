import type { GeoPlace } from "@/lib/domain/geo";
import { haversineKm } from "@/lib/facts/places";

/** Accent-, case- and space-insensitive form for comparing place names ("Málaga" = "malaga"). */
export const foldName = (s: string): string =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss").replace(/\s+/g, " ").trim();

/** Two places closer than this are the same suggestion (spec step 1, `duplicate`). */
export const DUPLICATE_KM = 30;

/**
 * Step 1 of the verification: the geocoding result that is the anchor town. Only populated places (PPL*) of the
 * stated country whose folded name equals the folded anchor; on a tie the largest population. null = not found.
 */
export function pickAnchorPlace(results: GeoPlace[], anchor: string, cc: string): GeoPlace | null {
  const wanted = foldName(anchor);
  const country = cc.trim().toUpperCase();
  if (!wanted) return null;
  const hits = results.filter(
    (p) => p.featureCode.startsWith("PPL") && p.countryCode?.toUpperCase() === country && foldName(p.name) === wanted,
  );
  if (hits.length === 0) return null;
  return hits.reduce((best, p) => ((p.population ?? 0) > (best.population ?? 0) ? p : best));
}

/** `city` when the label is the anchor itself, else `region` around the anchor town (spec [D8]). */
export const kindOf = (name: string, anchor: string): "city" | "region" => (foldName(name) === foldName(anchor) ? "city" : "region");

type Point = Pick<GeoPlace, "geoId" | "lat" | "lon">;
export function isDuplicate(p: Point, others: Point[]): boolean {
  return others.some((o) => o.geoId === p.geoId || haversineKm(o, p) < DUPLICATE_KM);
}
