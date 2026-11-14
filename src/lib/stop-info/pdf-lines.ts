/**
 * Stop info in the PDF (city-tour-stop-info 6, [Q2]): only with the opt-in "Ortsinfos aufnehmen". One line per stop:
 * the first sentence of the stored text, at most 140 characters (cut on a word with "…"); no pictures, no facts.
 * The tour block's source line names each Wikipedia article used (English fallbacks marked) with its link, the licence
 * and the oldest check date. Pure.
 */
import type { StopInfo, TourStopInfo } from "@/lib/domain/stop-info";

export const PDF_LINE_MAX = 140;

/** Common German and English abbreviations whose dot does not end a sentence (lower case, without the dot). */
const ABBREVIATIONS = new Set([
  "z", "b", "dr", "st", "nr", "ca", "bzw", "u", "a", "jh", "jhd", "mio", "mrd", "vgl", "ggf", "inkl", "evtl", "hl", "prof",
  "str", "e", "v", "chr", "n", "s", "o", "mr", "mrs", "ms", "jr", "sr", "no", "approx", "etc", "i", "vs", "mt", "ft",
]);

/**
 * End of the first sentence: ".", "!" or "?" followed by a space and a capital letter (or the end), unless the dot
 * belongs to a known abbreviation ("z. B.", "Dr.", "St."), a single letter, a word with an inner dot ("u.a.") or a
 * number ("19.").
 */
function firstSentence(text: string): string {
  const re = /[.!?](?=\s+\p{Lu}|$)/gu;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const word = /(\S+)$/.exec(text.slice(0, m.index))?.[1] ?? "";
    const abbreviation =
      text[m.index] === "." && (ABBREVIATIONS.has(word.toLowerCase()) || word.includes(".") || /^\d+$/.test(word));
    if (!abbreviation) return text.slice(0, m.index + 1);
  }
  return text;
}

/** First sentence, at most `max` characters including the "…". */
export function stopLine(text: string, max = PDF_LINE_MAX): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const first = firstSentence(clean);
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
    // Only text whose article can be credited in the source line (title and language known).
    if (!s || s.status !== "ok" || !s.text || !s.title || !s.lang) return null;
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
