import { FEEDBACK_SCREENSHOT_MAX_BYTES, FEEDBACK_TEXT_MAX, FEEDBACK_TEXT_MIN, type FeedbackError, type FeedbackKind } from "@/lib/domain/feedback";

/** Pure helpers for the feedback form (no DOM), so they can be unit tested. */

export const SCREENSHOT_MAX_EDGE = 1600;
export const SCREENSHOT_ACCEPT = "image/png,image/jpeg,image/webp";
export const SCREENSHOT_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
/** Raw file size we are willing to decode (bounds the memory of the bitmap decode; the result is re-encoded far smaller). */
export const SCREENSHOT_INPUT_MAX_BYTES = 15 * 1024 * 1024;
/** Quality steps tried in turn until the encoded blob fits the server limit. */
export const SCREENSHOT_QUALITIES = [0.85, 0.7, 0.5, 0.35] as const;

/** Scale to fit the long edge into `max`, never upscale, keep the aspect ratio, at least 1 px. */
export function fitWithin(width: number, height: number, max: number = SCREENSHOT_MAX_EDGE): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const long = Math.max(w, h);
  if (long <= max) return { width: w, height: h };
  const k = max / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

export type ScreenshotCheck = "ok" | "bad_type" | "too_big_input";

const EXT_OK = /\.(png|jpe?g|webp)$/i;

/** Some browsers/OSes report an empty MIME type; then the extension decides (the server checks magic bytes anyway). */
export function checkScreenshotInput(file: { type: string; size: number; name?: string }): ScreenshotCheck {
  const typeOk = file.type === "" ? EXT_OK.test(file.name ?? "") : (SCREENSHOT_MIME as readonly string[]).includes(file.type);
  if (!typeOk) return "bad_type";
  if (file.size > SCREENSHOT_INPUT_MAX_BYTES) return "too_big_input";
  return "ok";
}

export const fitsServerLimit = (bytes: number) => bytes > 0 && bytes <= FEEDBACK_SCREENSHOT_MAX_BYTES;

export type TextState = "empty" | "short" | "ok" | "long";
export function textState(text: string): TextState {
  const n = text.trim().length;
  if (n === 0) return "empty";
  if (n < FEEDBACK_TEXT_MIN) return "short";
  if (n > FEEDBACK_TEXT_MAX) return "long";
  return "ok";
}

/** Message key (under `feedback.errors`) for each server error code; unknown codes fall back to `failed`. */
const ERROR_KEYS: Record<FeedbackError, string> = {
  unauthenticated: "unauthenticated",
  invalid: "invalid",
  rate_limited: "rateLimited",
  demo_forbidden: "demoForbidden",
  too_large: "tooLarge",
  bad_image: "badImage",
  failed: "failed",
};
export function feedbackErrorKey(code: unknown): string {
  return typeof code === "string" && code in ERROR_KEYS ? ERROR_KEYS[code as FeedbackError] : "failed";
}

/**
 * Message key for a failed response. `rate_limited` with a `Retry-After` header is the burst guard (wait a moment);
 * without it, it is the daily limit. A 413 without a JSON body (proxy limit) counts as too large.
 */
export function responseErrorKey(status: number, json: unknown, retryAfter: string | null): string {
  const code = json && typeof json === "object" && "error" in json ? (json as { error: unknown }).error : undefined;
  if (code === "rate_limited") return retryAfter ? "rateLimitedBurst" : "rateLimited";
  if (code === undefined && status === 413) return "tooLarge";
  return feedbackErrorKey(code);
}

export type FeedbackFormInput = { kind: FeedbackKind; text: string; from?: string; viewport: number; screenshot?: Blob | null };

/** The multipart body of POST /api/feedback. */
export function buildFeedbackFormData(i: FeedbackFormInput): FormData {
  const body = new FormData();
  body.set("kind", i.kind);
  body.set("text", i.text.trim());
  body.set("pagePath", i.from ?? "");
  body.set("viewport", String(Math.round(i.viewport)));
  if (i.screenshot) body.set("screenshot", new File([i.screenshot], `screenshot.${i.screenshot.type === "image/webp" ? "webp" : "jpg"}`, { type: i.screenshot.type }));
  return body;
}

/** `?from=` value: only a plain same-origin path survives (no host, no `//`, no backslash), capped in length. */
export function safeFromPath(raw: string | string[] | undefined): string | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//") || v.includes("\\")) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(v)) return undefined;
  return v.slice(0, 600);
}

export function parseKind(raw: string | string[] | undefined): FeedbackKind {
  return (Array.isArray(raw) ? raw[0] : raw) === "idea" ? "idea" : "bug";
}
