/**
 * Wikipedia via the MediaWiki Action API (CC BY-SA 4.0), TextExtracts by title. Fallback for the destination
 * summary when the Wikivoyage intro is very short (Passau: one sentence, Marbella: one line).
 * Docs: https://www.mediawiki.org/wiki/Extension:TextExtracts (checked 2026-10-28).
 * Verified live 2026-10-28: `titles=Passau&redirects=1` on de.wikipedia.org returns the city (466 chars intro,
 * coordinates 48.573/13.457); Marbella de 539 chars, en 1181 chars. A title can be a disambiguation page or a
 * different place with the same name, so the page must not be a disambiguation and must lie within 25 km.
 */
import "server-only";
import { z } from "zod";
import type { DestinationSummary } from "@/lib/domain/facts";
import { haversineKm } from "@/lib/facts/places";
import { UpstreamError, fetchJson } from "./http";
import { clipParagraphs } from "./wikivoyage";

const MAX_KM = 25;

const page = z.object({
  title: z.string(),
  missing: z.boolean().optional(),
  extract: z.string().optional(),
  fullurl: z.string().optional(),
  coordinates: z.array(z.object({ lat: z.number(), lon: z.number() })).optional(),
  pageprops: z.record(z.string(), z.unknown()).optional(),
});
const response = z.object({
  error: z.object({ code: z.string() }).optional(),
  query: z.object({ pages: z.array(page) }).optional(),
});

export function parseWikipediaSummary(
  body: unknown,
  anchor: { lat: number; lon: number },
  lang: string,
): DestinationSummary | null {
  const parsed = response.parse(body);
  if (parsed.error) throw new UpstreamError(`Wikipedia: ${parsed.error.code}`);
  const p = parsed.query?.pages[0];
  if (!p || p.missing || !p.extract || !p.fullurl) return null;
  if (p.pageprops && "disambiguation" in p.pageprops) return null;
  const c = p.coordinates?.[0];
  if (!c || haversineKm(anchor, c) > MAX_KM) return null;
  const paragraphs = clipParagraphs(p.extract);
  if (!paragraphs.length) return null;
  return { title: p.title, extract: paragraphs.join("\n\n"), paragraphs, url: p.fullurl, lang };
}

export async function fetchWikipediaSummary(
  lat: number,
  lon: number,
  placeName: string,
  lang: "de" | "en",
): Promise<{ summary: DestinationSummary | null; status: number; latencyMs: number }> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    titles: placeName,
    redirects: "1",
    prop: "extracts|coordinates|info|pageprops",
    ppprop: "disambiguation",
    exintro: "1",
    explaintext: "1",
    inprop: "url",
  });
  const r = await fetchJson(`https://${lang}.wikipedia.org/w/api.php?${params}`);
  return { summary: parseWikipediaSummary(r.body, { lat, lon }, lang), status: r.status, latencyMs: r.latencyMs };
}
