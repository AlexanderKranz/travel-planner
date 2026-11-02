import "server-only";
import {
  clientLabel,
  detectScreenshotType,
  FEEDBACK_BUCKET,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  FEEDBACK_TEXT_MAX,
  newFeedbackRef,
  normalizePagePath,
  sanitizeFeedbackText,
  type FeedbackError,
  type FeedbackInput,
  type FeedbackScreenshotState,
} from "@/lib/domain/feedback";
import { logEvent } from "../events";
import { getSetting } from "../settings";
import { createSupabaseAdminClient } from "../supabase/admin";

const UNIQUE_VIOLATION = "23505";

export type SubmitParams = {
  ownerId: string;
  locale: "de" | "en";
  input: FeedbackInput;
  userAgent: string | null;
  screenshot: File | null;
};
export type SubmitResult = { ok: true; id: string; ref: string; screenshot: FeedbackScreenshotState } | { ok: false; error: FeedbackError };

/** Server-set version: first 7 characters of the commit, `local` outside Vercel (same as /api/health). */
export function appVersion(env: Record<string, string | undefined> = process.env): string {
  const v = env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
  return v && /^[0-9a-f]{7}$/.test(v) ? v : "local";
}

/**
 * Checks the screenshot (size, magic bytes) before anything is counted or stored. Pure of I/O apart from reading the file.
 */
export async function checkScreenshot(file: File): Promise<{ ok: true; bytes: Uint8Array; mime: string; ext: string } | { ok: false; error: "too_large" | "bad_image" }> {
  if (file.size > FEEDBACK_SCREENSHOT_MAX_BYTES) return { ok: false, error: "too_large" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > FEEDBACK_SCREENSHOT_MAX_BYTES) return { ok: false, error: "too_large" };
  const type = detectScreenshotType(bytes);
  return type ? { ok: true, bytes, mime: type.mime, ext: type.ext } : { ok: false, error: "bad_image" };
}

/**
 * Cleans the text, inserts through the atomic `feedback_submit` (per-user daily limit; fails closed) and stores the
 * optional screenshot. The caller has done auth, the demo block and the burst guard. Secret key on purpose: users have
 * no insert grant on `feedback` (spec D10), the limit lives in the SQL function.
 */
export async function submitFeedback(p: SubmitParams): Promise<SubmitResult> {
  const shot = p.screenshot ? await checkScreenshot(p.screenshot) : null;
  if (shot && !shot.ok) {
    await logEvent({ event: "feedback.rejected", level: "warn", userId: p.ownerId, props: { reason: shot.error } });
    return { ok: false, error: shot.error };
  }

  const text = sanitizeFeedbackText(p.input.text).slice(0, FEEDBACK_TEXT_MAX);
  if (!text) return { ok: false, error: "invalid" };
  const limit = Number((await getSetting("feedback_user_daily")).value);
  const admin = createSupabaseAdminClient();

  let id: string | null = null;
  let ref = "";
  for (let attempt = 0; attempt < 2 && !id; attempt++) {
    ref = newFeedbackRef();
    const { data, error } = await admin.rpc("feedback_submit", {
      p_owner: p.ownerId,
      p_ref: ref,
      p_kind: p.input.kind,
      p_body: text,
      p_page_path: normalizePagePath(p.input.pagePath),
      p_app_version: appVersion(),
      p_client: clientLabel(p.userAgent, p.input.viewport),
      p_locale: p.locale,
      p_limit: limit,
    });
    if (error) {
      if (error.code === UNIQUE_VIOLATION && attempt === 0) continue; // reference collision: one retry with a new one
      await logEvent({ event: "feedback.rejected", level: "warn", userId: p.ownerId, props: { reason: "submit_error" } });
      return { ok: false, error: "failed" }; // fails closed
    }
    const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; feedback_id?: string | null } | undefined;
    if (row?.outcome === "limited") {
      await logEvent({ event: "feedback.rate_limited", level: "warn", userId: p.ownerId, props: {} });
      return { ok: false, error: "rate_limited" };
    }
    if (row?.outcome === "created" && row.feedback_id) id = row.feedback_id;
    else return { ok: false, error: "failed" };
  }
  if (!id) return { ok: false, error: "failed" };

  let screenshot: FeedbackScreenshotState = "none";
  if (shot?.ok) {
    screenshot = (await storeScreenshot(admin, p.ownerId, id, shot)) ? "saved" : "failed";
  }
  await logEvent({ event: "feedback.submitted", userId: p.ownerId, props: { kind: p.input.kind, has_screenshot: screenshot === "saved" } });
  return { ok: true, id, ref, screenshot };
}

async function storeScreenshot(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  ownerId: string,
  id: string,
  shot: { bytes: Uint8Array; mime: string; ext: string },
): Promise<boolean> {
  const path = `${ownerId}/${id}.${shot.ext}`;
  try {
    const { error } = await admin.storage.from(FEEDBACK_BUCKET).upload(path, shot.bytes, { contentType: shot.mime, upsert: false });
    if (error) throw new Error("upload");
    const { error: upd } = await admin.from("feedback").update({ screenshot_path: path }).eq("id", id);
    if (upd) {
      await admin.storage.from(FEEDBACK_BUCKET).remove([path]);
      throw new Error("update");
    }
    return true;
  } catch {
    // The report itself is kept; only the screenshot is lost.
    await logEvent({ event: "feedback.rejected", level: "warn", userId: ownerId, props: { reason: "screenshot_store" } });
    return false;
  }
}
