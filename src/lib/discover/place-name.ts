import type { GeoPlace } from "@/lib/domain/geo";
import { featureRank, foldName } from "./names";

export { featureRank };

/**
 * Typed or extracted place names -> what the geocoder can find (port-places, implementation note 2026-11-12). Pure;
 * used by the stop geocoding on the server and by the trip form's destination from the first port. The displayed
 * stop name always stays as typed; only the search uses the cleaned form.
 */

/**
 * The searchable part of a place name. Open-Meteo finds nothing for "Messina (Sizilien)" but Messina IT for
 * "Messina", so a parenthetical ("(Sizilien)", "(Rom)") is dropped, and of "Name / Name2" and "Name, Region" only
 * the first part is searched. Falls back to the trimmed input when cleaning leaves nothing.
 */
export function cleanPlaceName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  const cleaned = trimmed
    .replace(/\s*\([^()]*\)\s*/g, " ")
    .split("/")[0]!
    .split(",")[0]!
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || trimmed;
}

/**
 * Leading articles retried without the article (port-places, 2026-11-12): "La Valletta" in German and English finds
 * only two Italian villages, "Valletta" the Maltese capital. Kept small on purpose: the Romance articles that start
 * port names, plus the German ones. Lower-case, followed by a space (or no space after the elided "l'").
 */
export const LEADING_ARTICLES = ["la ", "le ", "il ", "lo ", "l'", "l’", "el ", "los ", "las ", "der ", "die ", "das "] as const;

/** The name without a leading article from LEADING_ARTICLES; null when it has none or nothing would remain. */
export function stripLeadingArticle(name: string): string | null {
  const lower = name.toLowerCase();
  const article = LEADING_ARTICLES.find((a) => lower.startsWith(a));
  if (!article) return null;
  const rest = name.slice(article.length).trim();
  return rest ? rest : null;
}

/**
 * The trip destination for the first port of an upload (trip form): among the results, the populated places (PPL*)
 * whose folded name equals one of `names`; with a country hint only that country's places count (a namesake abroad
 * would be the wrong destination; the form then keeps the free-text name). Then the higher feature rank
 * (PPLC > PPLA* > PPL), then the larger population. null = no match.
 */
export function pickDestinationPlace(results: readonly GeoPlace[], names: readonly string[], cc?: string | null): GeoPlace | null {
  const wanted = new Set(names.map(foldName).filter(Boolean));
  const country = cc?.trim().toUpperCase() || null;
  const pool = results.filter(
    (p) => p.featureCode.startsWith("PPL") && wanted.has(foldName(p.name)) && (!country || p.countryCode?.toUpperCase() === country),
  );
  if (pool.length === 0) return null;
  return pool.reduce((best, p) => {
    const r = featureRank(p.featureCode) - featureRank(best.featureCode);
    if (r !== 0) return r > 0 ? p : best;
    return (p.population ?? 0) > (best.population ?? 0) ? p : best;
  });
}
