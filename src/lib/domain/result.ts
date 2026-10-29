/** Result of every server action. Actions return errors as data instead of throwing. */
export type ActionError =
  | "unauthenticated"
  | "invalid" // Zod validation failed, see `issues`
  | "not_found"
  | "unknown_airport"
  | "unknown_place" // trip destination geoId cannot be resolved
  | "limit_reached" // per-user cap (e.g. 30 trips)
  | "busy" // plan generation lock held
  | "conflict" // stale base version
  | "budget_exceeded" // daily AI budget (user, demo or global)
  | "rate_limited"
  | "too_long" // trip longer than MAX_PLAN_DAYS
  | "outdated" // plan basis differs from the trip, cannot iterate
  | "ai_disabled" // AI_ENABLED off or no API key
  | "ai_unavailable" // API/network error
  | "ai_refused" // model refusal
  | "invalid_output" // model output failed validation
  | "demo_forbidden" // demo account cannot create share links
  | "no_plan" // trip has no plan version yet
  | "forbidden" // not an admin
  | "already_member" // invite: this address already has an account
  | "email_failed" // invite: allowlisted, but the mail could not be sent
  | "places_pending" // places with a source did not load yet; retry or generate anyway
  | "failed";

export type ActionResult<T = void> =
  | (T extends void ? { ok: true } : { ok: true; data: T })
  | { ok: false; error: ActionError; issues?: { path: string; message: string }[] };

export function fail(
  error: ActionError,
  issues?: { path: string; message: string }[],
): { ok: false; error: ActionError; issues?: { path: string; message: string }[] } {
  return issues ? { ok: false, error, issues } : { ok: false, error };
}

export function zodIssues(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  return error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
}
