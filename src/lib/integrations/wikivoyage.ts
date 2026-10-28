/**
 * Wikivoyage via the MediaWiki Action API (CC BY-SA 4.0), geosearch + TextExtracts.
 * Docs: https://www.mediawiki.org/wiki/API:Geosearch, https://www.mediawiki.org/wiki/Extension:TextExtracts,
 * etiquette https://meta.wikimedia.org/wiki/User-Agent_policy (checked 2026-10-28).
 * Verified live 2026-10-28: TextExtracts works on de.wikivoyage.org (`exintro`, `explaintext`); the intro of Passau is
 * one sentence, Marbella one line, Vienna ~1000 chars in 2-3 paragraphs (separated by "\n" in the extract), so we take
 * the whole intro (no `exsentences`) and cut it ourselves at <= 900 chars on a sentence boundary (2026-10-28). Page order in the result is NOT by
 * distance (Inn had index -1, Passau index 0), so we compute distance from `coordinates`. Under load the API
 * answers HTTP 200 with `{"error":{"code":"cirrussearch-too-busy-error"}}`: treated as failure, never cached.
 * No hit within the radius returns `{"batchcomplete":true}` without `query`.
 */
import "server-only";
import { z } from "zod";
import type { DestinationSummary } from "@/lib/domain/facts";
import { haversineKm } from "@/lib/facts/places";
import { UpstreamError, fetchJson } from "./http";

const page = z.object({
  title: z.string(),
  extract: z.string().optional(),
  fullurl: z.string().optional(),
  coordinates: z.array(z.object({ lat: z.number(), lon: z.number() })).optional(),
});
const response = z.object({
  error: z.object({ code: z.string() }).optional(),
  query: z.object({ pages: z.array(page) }).optional(),
});

const fold = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss").replace(/\s+/g, " ").trim();

/** Target length of the shown intro: about 3 short paragraphs. Cut at a sentence boundary. */
export const MAX_EXTRACT_CHARS = 900;
const MIN_SENTENCE_CUT = 300;
const NEAREST_KM = 5;

/** Keeps whole paragraphs while they fit, then cuts the next one at its last sentence end (else at a word, with an ellipsis). */
export function clipParagraphs(text: string, max = MAX_EXTRACT_CHARS): string[] {
  const paras = text
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const out: string[] = [];
  let used = 0;
  for (const para of paras) {
    const sep = out.length ? 2 : 0;
    if (used + sep + para.length <= max) {
      out.push(para);
      used += sep + para.length;
      continue;
    }
    const room = max - used - sep;
    const head = para.slice(0, Math.max(0, room));
    let end = -1;
    for (const m of head.matchAll(/[.!?](?=\s|$)/g)) end = m.index + 1;
    // Keep a partial paragraph only if it adds a reasonable amount; the first paragraph is always cut to fit.
    if (end >= 80 || (!out.length && end > 0)) out.push(head.slice(0, end));
    else if (!out.length) {
      const space = head.lastIndexOf(" ");
      out.push(`${head.slice(0, space > MIN_SENTENCE_CUT ? space : head.length).trimEnd()}…`);
    }
    break;
  }
  return out;
}

/** Title match (accent-insensitive) first, else the nearest page within 5 km, else null. */
export function parseSummary(
  body: unknown,
  anchor: { lat: number; lon: number; placeName: string },
  lang: string,
): DestinationSummary | null {
  const parsed = response.parse(body);
  if (parsed.error) throw new UpstreamError(`Wikivoyage: ${parsed.error.code}`);
  const pages = (parsed.query?.pages ?? []).filter((p) => p.extract && p.fullurl);
  const toSummary = (p: (typeof pages)[number]): DestinationSummary => {
    const paragraphs = clipParagraphs(p.extract ?? "");
    return { title: p.title, extract: paragraphs.join("\n\n"), paragraphs, url: p.fullurl ?? "", lang };
  };
  const byTitle = pages.find((p) => fold(p.title) === fold(anchor.placeName));
  if (byTitle) return toSummary(byTitle);
  let best: { p: (typeof pages)[number]; d: number } | null = null;
  for (const p of pages) {
    const c = p.coordinates?.[0];
    if (!c) continue;
    const d = haversineKm(anchor, c);
    if (d <= NEAREST_KM && (!best || d < best.d)) best = { p, d };
  }
  return best ? toSummary(best.p) : null;
}

export async function fetchSummary(
  lat: number,
  lon: number,
  placeName: string,
  lang: "de" | "en",
): Promise<{ summary: DestinationSummary | null; status: number; latencyMs: number }> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "geosearch",
    ggscoord: `${lat}|${lon}`,
    ggsradius: "10000",
    ggslimit: "5",
    prop: "extracts|coordinates|info",
    exintro: "1",
    explaintext: "1",
    inprop: "url",
    redirects: "1",
  });
  const r = await fetchJson(`https://${lang}.wikivoyage.org/w/api.php?${params}`);
  return { summary: parseSummary(r.body, { lat, lon, placeName }, lang), status: r.status, latencyMs: r.latencyMs };
}
