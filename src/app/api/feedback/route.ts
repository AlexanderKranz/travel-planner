import { after, NextResponse } from "next/server";
import {
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  FeedbackInput,
  type FeedbackError,
  type FeedbackResponse,
} from "@/lib/domain/feedback";
import { Locale } from "@/lib/domain/profile";
import { logEvent } from "@/lib/server/events";
import { deliverFeedback } from "@/lib/server/feedback/deliver";
import { submitFeedback } from "@/lib/server/feedback/submit";
import { rateLimit } from "@/lib/server/rate-limit";
import { getUserSession } from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const STATUS: Record<FeedbackError, number> = {
  unauthenticated: 401,
  invalid: 400,
  rate_limited: 429,
  demo_forbidden: 403,
  too_large: 413,
  bad_image: 400,
  failed: 500,
};
const headers = { "Cache-Control": "no-store" };
const err = (error: FeedbackError, extra: HeadersInit = {}) =>
  NextResponse.json({ ok: false, error } satisfies FeedbackResponse, { status: STATUS[error], headers: { ...headers, ...extra } });

// Multipart body (text + one screenshot), so a route handler instead of a server action (1 MB body limit there).
const MAX_BODY_BYTES = FEEDBACK_SCREENSHOT_MAX_BYTES + 256 * 1024;

const str = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : undefined);

/**
 * POST /api/feedback (multipart: kind, text, pagePath, viewport?, screenshot?) -> { ok, ref } | { ok: false, error }.
 * Order matters (spec D8/D9): session, demo block, burst guard, body, then the atomic per-user limit, then Storage.
 * The answer is "received" whatever GitHub does; the issue is attempted afterwards in after().
 */
export async function POST(request: Request) {
  const session = await getUserSession();
  if (!session) return err("unauthenticated");

  // Fails closed: if the profile cannot be read, nothing is counted, uploaded or inserted.
  const { data: profile, error: profileError } = await session.supabase
    .from("profiles")
    .select("is_demo, locale")
    .eq("id", session.userId)
    .maybeSingle<{ is_demo: boolean | null; locale: string | null }>();
  if (profileError || !profile) return err("failed");
  if (profile.is_demo) {
    await logEvent({ event: "feedback.rejected", level: "warn", userId: session.userId, props: { reason: "demo" } });
    return err("demo_forbidden");
  }

  const burst = rateLimit(`feedback:${session.userId}`, 3, 60_000);
  if (!burst.ok) {
    await logEvent({ event: "feedback.rate_limited", level: "warn", userId: session.userId, props: { scope: "burst" } });
    return err("rate_limited", { "Retry-After": String(burst.retryAfterSeconds) });
  }

  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return err("too_large");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return err("invalid");
  }
  const parsed = FeedbackInput.safeParse({
    kind: str(form.get("kind")),
    text: str(form.get("text")),
    pagePath: str(form.get("pagePath")),
    viewport: str(form.get("viewport")),
  });
  if (!parsed.success) return err("invalid");
  const file = form.get("screenshot");
  const screenshot = file instanceof File && file.size > 0 ? file : null;
  const locale = Locale.catch("de").parse(profile.locale ?? "de");

  const result = await submitFeedback({
    ownerId: session.userId,
    locale,
    input: parsed.data,
    userAgent: request.headers.get("user-agent"),
    screenshot,
  });
  if (!result.ok) return err(result.error);

  after(async () => {
    await deliverFeedback(result.id, { userId: session.userId });
  });
  return NextResponse.json({ ok: true, ref: result.ref, screenshot: result.screenshot } satisfies FeedbackResponse, { headers });
}
