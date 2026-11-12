import {
  ITINERARY_IMAGE_TYPES,
  MAX_ITINERARY_IMAGES,
  type ExtractedStop,
  type ItineraryContext,
  type ItineraryExtractError,
  type ItineraryExtractInput,
  type ItineraryExtractResult,
  type ItineraryPath,
} from "@/lib/domain/itinerary";
import { prefilterItinerary } from "@/lib/itinerary/prefilter";
import { parseItinerary } from "@/lib/itinerary/parse";

/** Limits of docs/specs/itinerary-upload.md section 6. */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_PDF_PAGES = 10;
export const MAX_SCAN_PAGES = MAX_ITINERARY_IMAGES;
export const MAX_IMAGE_EDGE = 1568;
/** "Has a text layer" = at least this many non-space characters per page on average. */
export const TEXT_LAYER_MIN_CHARS = 40;
export const FILE_ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";

/** Message keys under `trips.stops.error`. */
export type ItineraryErrorKey = "unreadable" | "noStops" | "tooLarge" | "unsupportedType" | "aiOff" | "limit" | "forbidden";

export type FileCheck = { ok: true; kind: "pdf" | "image" } | { ok: false; error: ItineraryErrorKey };

/** Type and size check of a picked file (HEIC and the like are refused before anything is read). */
export function checkFile(file: { type: string; size: number }): FileCheck {
  const kind = file.type === "application/pdf" ? "pdf" : (ITINERARY_IMAGE_TYPES as readonly string[]).includes(file.type) ? "image" : null;
  if (!kind) return { ok: false, error: "unsupportedType" };
  if (file.size > MAX_FILE_BYTES) return { ok: false, error: "tooLarge" };
  return { ok: true, kind };
}

/** Text layer heuristic: average non-space characters per page. */
export function hasTextLayer(pageTexts: readonly string[]): boolean {
  if (pageTexts.length === 0) return false;
  const chars = pageTexts.reduce((n, t) => n + t.replace(/\s/g, "").length, 0);
  return chars / pageTexts.length >= TEXT_LAYER_MIN_CHARS;
}

/** Pages (1-based) whose text layer is too thin to read: scanned or image-only. */
export function textlessPages(pageTexts: readonly string[]): number[] {
  const out: number[] = [];
  pageTexts.forEach((t, i) => {
    if (t.replace(/\s/g, "").length < TEXT_LAYER_MIN_CHARS) out.push(i + 1);
  });
  return out;
}

export type PdfPlan =
  | { mode: "text" }
  /** Every page lacks text: render these pages (at most MAX_SCAN_PAGES) and send images. */
  | { mode: "scan"; pages: number[] }
  /** Text pages first (parser); only if they are not usable, send these textless pages as images. */
  | { mode: "mixed"; pages: number[] };

/** How to read a PDF, judged per page so a text cover cannot hide an image-only itinerary page. */
export function planPdfRead(pageTexts: readonly string[]): PdfPlan {
  const textless = textlessPages(pageTexts);
  if (textless.length === 0) return { mode: "text" };
  const pages = textless.slice(0, MAX_SCAN_PAGES);
  return textless.length === pageTexts.length ? { mode: "scan", pages } : { mode: "mixed", pages };
}

/** Size that fits `max` on the long edge, never enlarged. */
export function fitSize(width: number, height: number, max = MAX_IMAGE_EDGE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Maps a server error to the message key shown to the user. */
export function errorKey(error: ItineraryExtractError): ItineraryErrorKey {
  switch (error) {
    case "ai_off":
    case "demo":
      return "aiOff";
    case "rate_limited":
    case "budget":
      return "limit";
    case "no_stops":
      return "noStops";
    case "forbidden":
      return "forbidden";
    case "invalid":
    case "failed":
      return "unreadable";
  }
}

/** What the browser could take from a document: text (prefiltered here) or downscaled images. */
export type ItinerarySource =
  | {
      kind: "text";
      text: string;
      /** Renders the textless pages; used when the text alone does not parse usably. */
      scanFallback?: () => Promise<Extract<ItineraryExtractInput, { kind: "images" }>["images"]>;
    }
  | { kind: "images"; images: Extract<ItineraryExtractInput, { kind: "images" }>["images"] };

export type ItineraryOutcome =
  | { ok: true; path: ItineraryPath; stops: ExtractedStop[] }
  | { ok: false; error: ItineraryErrorKey };

/**
 * Section 3 pipeline after the file is read: prefilter, then the parser (0 tokens), and only when it is not usable
 * the server's AI path. Images always go to the server. `extract` is injected so the logic is testable.
 */
export async function extractFromSource(
  source: ItinerarySource,
  ctx: ItineraryContext,
  extract: (input: ItineraryExtractInput) => Promise<ItineraryExtractResult>,
): Promise<ItineraryOutcome> {
  let input: ItineraryExtractInput;
  if (source.kind === "text") {
    const text = prefilterItinerary(source.text);
    if (text.trim() === "" && !source.scanFallback) return { ok: false, error: "noStops" };
    const parsed = text.trim() === "" ? null : parseItinerary(text, ctx);
    if (parsed?.usable) return { ok: true, path: "parser", stops: parsed.stops };
    if (source.scanFallback) {
      try {
        input = { kind: "images", images: await source.scanFallback() };
      } catch {
        return { ok: false, error: "unreadable" };
      }
    } else {
      input = { kind: "text", text };
    }
  } else {
    input = { kind: "images", images: source.images };
  }
  try {
    const res = await extract(input);
    if (!res.ok) return { ok: false, error: errorKey(res.error) };
    if (res.stops.length === 0) return { ok: false, error: "noStops" };
    return res;
  } catch {
    return { ok: false, error: "unreadable" };
  }
}
