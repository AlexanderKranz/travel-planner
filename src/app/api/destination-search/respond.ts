import { NextResponse } from "next/server";
import type { ActionError } from "@/lib/domain/result";
import type { SearchResult } from "@/lib/server/discover/pipeline";
import { NO_STORE, STATUS } from "../trips/[id]/plan/respond";

/**
 * `200 { search: DestinationSearchView }` or `{ error, resetAt?, retryAfter? }` with the status of the error code.
 * The body error is always an ActionError code (the UI maps it to `errors.<code>`).
 */
export function respond(res: SearchResult): NextResponse {
  if (res.ok) return NextResponse.json({ search: res.data }, { headers: NO_STORE });
  const headers: Record<string, string> = { ...NO_STORE };
  if (res.retryAfter !== undefined) headers["Retry-After"] = String(res.retryAfter);
  const body: { error: ActionError; resetAt?: string; retryAfter?: number; issues?: { path: string; message: string }[] } = { error: res.error };
  if (res.resetAt) body.resetAt = res.resetAt;
  if (res.retryAfter !== undefined) body.retryAfter = res.retryAfter;
  if (res.issues) body.issues = res.issues;
  return NextResponse.json(body, { status: STATUS[res.error], headers });
}

export { NO_STORE };
