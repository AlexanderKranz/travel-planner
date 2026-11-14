/**
 * Stop info in the PDF (city-tour-stop-info 6, [Q2]): only with the opt-in "Ortsinfos aufnehmen". One line per stop:
 * the first sentence of the stored text, at most 140 characters (cut on a word with "…"); no pictures, no facts.
 * The tour block's source line names each Wikipedia article used (English fallbacks marked) with its link, the licence
 * and the oldest check date. Pure.
 */
import type { StopInfo, TourStopInfo } from "@/lib/domain/stop-info";

export const PDF_LINE_MAX = 140;

/** First sentence, at most `max` characters including the "…". */
export function stopLine(text: string, max = PDF_LINE_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(clean);
  const first = m ? m[1] : clean;
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:–-]+$/, "")}…`;
}

export type PdfArticle = { title: string; url: string; en: boolean };
export type PdfStopInfo = {
  /** Parallel to the block's stops: the line, or null (no text stored for that stop). */
  lines: (string | null)[];
  articles: PdfArticle[];
  /** Oldest `checkedAt` of the stops shown (ISO). */
  checkedAt: string | null;
};

const articleUrl = (lang: string, title: string) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;

/** Lines and attribution for the stops of a block (`keys` in visiting order), or null when no stop has text. */
export function pdfStopInfo(info: TourStopInfo | null | undefined, keys: readonly string[]): PdfStopInfo | null {
  if (!info) return null;
  const byKey = new Map<string, StopInfo>(info.stops.map((s) => [s.key, s]));
  const used: StopInfo[] = [];
  const lines = keys.map((k) => {
    const s = byKey.get(k);
    if (!s || s.status !== "ok" || !s.text) return null;
    if (!used.includes(s)) used.push(s);
    return stopLine(s.text);
  });
  if (used.length === 0) return null;
  const articles = used.flatMap((s) =>
    s.title && s.lang ? [{ title: s.title, url: articleUrl(s.lang, s.title), en: s.lang !== info.locale }] : [],
  );
  const checkedAt = used.map((s) => s.checkedAt).sort()[0] ?? null;
  return { lines, articles, checkedAt };
}
