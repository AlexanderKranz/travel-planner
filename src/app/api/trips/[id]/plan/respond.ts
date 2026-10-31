import { NextResponse } from "next/server";
import type { ActionError } from "@/lib/domain/result";
import type { PipelineResult } from "@/lib/server/plan-pipeline";

const NO_STORE = { "Cache-Control": "no-store" };

const STATUS: Record<ActionError, number> = {
  unauthenticated: 401,
  not_found: 404,
  busy: 409,
  conflict: 409,
  invalid: 422,
  too_long: 422,
  outdated: 422,
  rate_limited: 429,
  budget_exceeded: 429,
  ai_unavailable: 502,
  ai_refused: 502,
  invalid_output: 502,
  ai_disabled: 503,
  unknown_airport: 422,
  unknown_place: 422,
  limit_reached: 422,
  demo_forbidden: 403,
  no_plan: 409,
  places_pending: 503,
  forbidden: 403,
  protected: 403,
  already_member: 409,
  email_failed: 502,
  invalid_credentials: 401,
  weak_password: 422,
  same_password: 422,
  reauth_required: 401,
  failed: 500,
};

/** Spec 5.3: `200 { state, unchanged?, reply? }` or `{ error, resetAt?, retryAfter? }` with the mapped status. */
export function respond(res: PipelineResult): NextResponse {
  if (res.ok) return NextResponse.json(res.data, { headers: NO_STORE });
  const headers: Record<string, string> = { ...NO_STORE };
  if (res.retryAfter !== undefined) headers["Retry-After"] = String(res.retryAfter);
  // Body error is always an ActionError code (the plan client maps it to plan.errors.<code>).
  const body: { error: ActionError; resetAt?: string; retryAfter?: number } = { error: res.error };
  if (res.resetAt) body.resetAt = res.resetAt;
  if (res.retryAfter !== undefined) body.retryAfter = res.retryAfter;
  return NextResponse.json(body, { status: STATUS[res.error], headers });
}

export function badRequest(): NextResponse {
  return NextResponse.json({ error: "invalid" }, { status: 422, headers: NO_STORE });
}

export { NO_STORE };
