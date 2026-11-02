import { FEEDBACK_SCREENSHOT_MAX_BYTES, FEEDBACK_TEXT_MAX, FEEDBACK_TEXT_MIN, type FeedbackError, type FeedbackKind } from "@/lib/domain/feedback";

/** Pure helpers for the feedback form (no DOM), so they can be unit tested. */

export const SCREENSHOT_MAX_EDGE = 1600;
export const SCREENSHOT_ACCEPT = "image/png,image/jpeg,image/webp";
export const SCREENSHOT_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
/** Size of the raw file we are willing to decode at all (the result is re-encoded far smaller). */
export const SCREENSHOT_INPUT_MAX_BYTES = 25 * 1024 * 1024;
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

export function checkScreenshotInput(file: { type: string; size: number }): ScreenshotCheck {
  if (!(SCREENSHOT_MIME as readonly string[]).includes(file.type)) return "bad_type";
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

/** `?from=` value: only a plain same-origin path survives (no host, no `//`, no backslash), capped in length. */
export function safeFromPath(raw: string | string[] | undefined): string | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//") || v.includes("\\")) return undefined;
  return v.slice(0, 600);
}

export function parseKind(raw: string | string[] | undefined): FeedbackKind {
  return (Array.isArray(raw) ? raw[0] : raw) === "idea" ? "idea" : "bug";
}
