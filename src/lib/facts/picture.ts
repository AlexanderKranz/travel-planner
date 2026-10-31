/**
 * Pure rules that turn a Commons file description into a destination picture, or reject it.
 * A bad picture is worse than none: every doubt returns null.
 */
import { DestinationPicture } from "@/lib/domain/picture";

export type CommonsFile = {
  /** "File:Passau-banner-s1.jpg" */
  title: string;
  mime: string;
  width: number;
  height: number;
  /** Original file URL as given by Commons. */
  url: string;
  descriptionUrl: string;
  licenseShortName: string | null;
  licenseUrl: string | null;
  /** Untrusted HTML. */
  artistHtml: string | null;
};

/** Commons title form of a Wikidata file name: spaces for underscores, first letter upper case. */
export function commonsTitle(name: string): string {
  const n = name.replace(/_/g, " ").trim();
  return `File:${n.charAt(0).toUpperCase()}${n.slice(1)}`;
}

export const MIN_IMAGE_WIDTH = 1200;
export const MIN_BANNER_WIDTH = 800;
/** One of Wikimedia's standard thumbnail steps (20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840); other widths answer HTTP 400. */
export const THUMB_WIDTH = 1920;
const MAX_AUTHOR_CHARS = 120;
const RASTER_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "" };

/** Untrusted Commons `Artist` HTML to plain text: no tags, no entities, one line, capped. Never returns markup. */
export function artistToText(html: string | null | undefined, max = MAX_AUTHOR_CHARS): string | null {
  if (!html) return null;
  let s = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(br|p|div|li|tr|td)\b[^>]*>/gi, " ");
  // Until stable: removing one tag can join its neighbours into a new one ("<scr<b>ipt>").
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/<[^>]*>/g, "");
  }
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 31 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  // Entities may have produced angle brackets: never let anything markup-like through.
  s = s.replace(/[<>]/g, " ").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮]/g, " ");
  s = s.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (!s || /^(unknown|unbekannt|anonymous|anonym|n\/a|none)(\b.*)?$/i.test(s) && s.length < 30) return null;
  if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
  return s;
}

export type LicenseInfo = { name: string; url: string | null; needsAttribution: boolean };

const CC_BY = /^CC[ -]BY(-SA)?[ -](\d)\.(\d)(?:[ -]([A-Za-z]{2,3}))?$/i;

/** Allow-list: CC0, public domain, CC BY, CC BY-SA (any version). Everything else (NC, ND, GFDL, unknown) is null. */
export function classifyLicense(shortName: string | null, licenseUrl: string | null): LicenseInfo | null {
  const name = shortName?.replace(/\s+/g, " ").trim() ?? "";
  if (!name || name.length > 60) return null;
  if (/^CC0(?:[ -]1\.0)?$/i.test(name)) return { name, url: ccUrl(licenseUrl) ?? "https://creativecommons.org/publicdomain/zero/1.0/", needsAttribution: false };
  if (/^(public domain|pd)(\b|-)/i.test(name) && !/\b(nc|nd)\b/i.test(name)) {
    return { name, url: null, needsAttribution: false };
  }
  const m = CC_BY.exec(name);
  if (!m) return null;
  const sa = m[1] ? "-sa" : "";
  return {
    name,
    url: ccUrl(licenseUrl) ?? `https://creativecommons.org/licenses/by${sa}/${m[2]}.${m[3]}/`,
    needsAttribution: true,
  };
}

/** Only creativecommons.org licence pages, upgraded to https. */
function ccUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.hostname !== "creativecommons.org") return null;
    return `https://creativecommons.org${u.pathname}`;
  } catch {
    return null;
  }
}

const BAD_TOKENS = new Set([
  "map", "maps", "karte", "karten", "locator", "location", "locationmap", "flag", "flagge", "wappen", "coa", "arms",
  "satellite", "satellit", "satelliten", "landsat", "sentinel", "nasa", "logo", "seal", "siegel", "emblem",
  "stadtplan", "lageplan", "plan", "diagram", "chart", "blank", "outline", "topographic", "relief", "iss",
  "orthophoto", "svg", "stadtwappen",
]);
const BAD_SUBSTRINGS = ["coatofarms", "coat of arms", "coat_of_arms", "wappen", "landsat", "satellite", "locator", "locationmap"];

/** True for file names that are obviously not a photo (map, flag, coat of arms, satellite image, logo ...). */
export function looksLikeNonPhoto(title: string): boolean {
  const name = title.replace(/^File:/i, "").replace(/\.[a-z0-9]+$/i, "").toLowerCase();
  if (BAD_SUBSTRINGS.some((s) => name.includes(s))) return true;
  return name.split(/[^\p{L}\p{N}]+/u).some((t) => BAD_TOKENS.has(t));
}

const UPLOAD_PATH = /^\/wikipedia\/commons\/([0-9a-f])\/([0-9a-f]{2})\/([^/]{1,200})$/;

/**
 * https://upload.wikimedia.org URL for display: the original when it is not wider than THUMB_WIDTH, else the
 * 1920 px thumbnail (`/thumb/<h>/<hh>/<name>/1920px-<name>`). Null if the original URL is not a plain Commons upload.
 */
export function displayUrl(originalUrl: string, width: number, height: number): { url: string; width: number; height: number } | null {
  let u: URL;
  try {
    u = new URL(originalUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "upload.wikimedia.org") return null;
  const m = UPLOAD_PATH.exec(u.pathname);
  if (!m) return null;
  if (width <= THUMB_WIDTH) return { url: `https://upload.wikimedia.org${u.pathname}`, width, height };
  const [, a, ab, name] = m;
  return {
    url: `https://upload.wikimedia.org/wikipedia/commons/thumb/${a}/${ab}/${name}/${THUMB_WIDTH}px-${name}`,
    width: THUMB_WIDTH,
    height: Math.max(1, Math.round((height * THUMB_WIDTH) / width)),
  };
}

/** Builds the domain picture from one Commons file, or null if it fails the quality, licence or attribution rules. */
export function pictureFromFile(file: CommonsFile, kind: "banner" | "image"): DestinationPicture | null {
  if (!RASTER_MIME.has(file.mime.toLowerCase())) return null;
  if (!/\.(jpe?g|png|webp)$/i.test(file.title)) return null;
  if (file.width <= 0 || file.height <= 0) return null;
  if (kind === "banner") {
    if (file.width < MIN_BANNER_WIDTH || file.width / file.height < 2) return null;
  } else {
    if (file.width < MIN_IMAGE_WIDTH || file.width / file.height < 1.3) return null;
    if (looksLikeNonPhoto(file.title)) return null;
  }
  const license = classifyLicense(file.licenseShortName, file.licenseUrl);
  if (!license) return null;
  const author = artistToText(file.artistHtml);
  if (license.needsAttribution && !author) return null;
  const shown = displayUrl(file.url, file.width, file.height);
  if (!shown) return null;
  let page: URL;
  try {
    page = new URL(file.descriptionUrl);
  } catch {
    return null;
  }
  if (page.protocol !== "https:" || page.hostname !== "commons.wikimedia.org" || !page.pathname.startsWith("/wiki/File:")) return null;
  const parsed = DestinationPicture.safeParse({
    ...shown,
    author,
    licenseName: license.name,
    licenseUrl: license.url,
    sourcePageUrl: `https://commons.wikimedia.org${page.pathname}`,
    kind,
    title: file.title.replace(/^File:/i, ""),
  });
  return parsed.success ? parsed.data : null;
}

/** First usable picture: banners (editor-chosen, P948) in order, then main images (P18). */
export function choosePicture(
  files: Map<string, CommonsFile>,
  banners: string[],
  images: string[],
): DestinationPicture | null {
  for (const [names, kind] of [[banners, "banner"], [images, "image"]] as const) {
    for (const n of names) {
      const f = files.get(commonsTitle(n));
      const p = f ? pictureFromFile(f, kind) : null;
      if (p) return p;
    }
  }
  return null;
}
