/**
 * One stop card from the fetched pieces (docs/specs/city-tour-stop-info.md sections 3 and 4). Pure: no calls, no
 * strings for the UI (rule 5; the UI words the facts from `yearKind`).
 */
import { STOP_TEXT_MAX, StopInfo, type StopFacts, type StopImage, type StopInfoLocale } from "@/lib/domain/stop-info";
import { artistToText, classifyLicense, looksLikeNonPhoto } from "@/lib/facts/picture";
import { clipParagraphs } from "@/lib/integrations/wikivoyage";
import { cleanWebsite, yearKind, type OsmFacts } from "./match";

/** Shapes of the client results this builder needs (kept structural so the pure code imports no server module). */
export type EntityPart = {
  sitelinks: { de?: string; en?: string };
  image: string | null;
  year: number | null;
  architects: string[];
  heritage: string | null;
  website: string | null;
};
export type ExtractPart = { title: string; text: string };
export type ThumbPart = {
  thumbUrl: string;
  width: number;
  height: number;
  mime: string;
  licenseShortName: string | null;
  licenseUrl: string | null;
  artistHtml: string | null;
};

const IMAGE_HOST = "upload.wikimedia.org";
const RASTER = /^image\/(jpeg|png|webp)$/;

/** Intro clipped on a sentence to at most 700 characters including "…"; `clipped` when anything was cut. */
export function clipStopText(text: string): { text: string; clipped: boolean } | null {
  const clean = text.replace(/\s+\n/g, "\n").trim();
  if (!clean) return null;
  const parts = clipParagraphs(clean, STOP_TEXT_MAX - 1);
  let out = parts.join("\n\n");
  if (!out) return null;
  if (out.length > STOP_TEXT_MAX) out = `${out.slice(0, STOP_TEXT_MAX - 1).trimEnd()}…`;
  const full = clean.replace(/\n+/g, "\n\n").replace(/[ \t]+/g, " ");
  return { text: out, clipped: out.length < full.length };
}

/** A free-licensed raster thumbnail on upload.wikimedia.org; CC BY / BY-SA need an artist (spec 12). */
export function stopImage(file: string, t: ThumbPart | undefined): StopImage | null {
  if (!t || !RASTER.test(t.mime) || looksLikeNonPhoto(file)) return null;
  let url: URL;
  try {
    url = new URL(t.thumbUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== IMAGE_HOST) return null;
  const licence = classifyLicense(t.licenseShortName, t.licenseUrl);
  if (!licence) return null;
  const artist = artistToText(t.artistHtml, 200);
  if (licence.needsAttribution && !artist) return null;
  return {
    url: url.href,
    w: Math.round(t.width),
    h: Math.round(t.height),
    licence: licence.name.slice(0, 60),
    ...(licence.url ? { licenceUrl: licence.url } : {}),
    ...(artist ? { artist } : {}),
    file: file.slice(0, 240),
  };
}

export type BuildInput = {
  key: string;
  cat?: string;
  locale: StopInfoLocale;
  checkedAt: string;
  storedAt?: string;
  qid: string | null;
  osm: OsmFacts | null;
  entity: EntityPart | null;
  /** The text chosen for this stop (owner's language, else English) with its language, or null. */
  extract: { lang: StopInfoLocale; part: ExtractPart } | null;
  thumb: ThumbPart | undefined;
  labels: Map<string, { de?: string; en?: string }>;
};

const label = (labels: BuildInput["labels"], qid: string, locale: StopInfoLocale) => {
  const l = labels.get(qid);
  const v = (locale === "de" ? l?.de ?? l?.en : l?.en ?? l?.de)?.trim();
  return v ? v : null;
};

export function buildStopInfo(b: BuildInput): StopInfo {
  const facts: StopFacts = {};
  const e = b.entity;
  if (e?.year) {
    facts.year = e.year;
    facts.yearKind = yearKind(b.cat);
  }
  const architects = (e?.architects ?? []).map((q) => label(b.labels, q, b.locale)).filter((x): x is string => !!x);
  if (architects.length) facts.architects = architects.map((a) => a.slice(0, 80)).slice(0, 2);
  const heritage = e?.heritage ? label(b.labels, e.heritage, b.locale) : null;
  if (heritage) facts.heritage = heritage.slice(0, 120);
  const osmSite = b.osm?.website ?? null;
  const wdSite = cleanWebsite(e?.website);
  if (osmSite) Object.assign(facts, { website: osmSite, websiteFrom: "osm" });
  else if (wdSite) Object.assign(facts, { website: wdSite, websiteFrom: "wikidata" });
  if (b.osm?.openingHours) facts.openingHours = b.osm.openingHours;

  const text = b.extract ? clipStopText(b.extract.part.text) : null;
  const image = e?.image ? stopImage(e.image, b.thumb) : null;
  const hasFacts = Object.keys(facts).length > 0;
  const stamp = b.storedAt ? { storedAt: b.storedAt } : {};
  if (!text && !image && !hasFacts) return { key: b.key, status: "none", checkedAt: b.checkedAt, ...stamp };

  return StopInfo.parse({
    key: b.key,
    status: "ok",
    checkedAt: b.checkedAt,
    ...stamp,
    ...(b.qid ? { qid: b.qid } : {}),
    ...(text && b.extract ? { lang: b.extract.lang, title: b.extract.part.title.slice(0, 200), text: text.text, ...(text.clipped ? { clipped: true } : {}) } : {}),
    ...(image ? { image } : {}),
    ...(hasFacts ? { facts } : {}),
  });
}
