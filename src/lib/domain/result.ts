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
  | "protected" // admin user action on yourself, the demo account or another admin
  | "already_member" // invite: this address already has an account
  | "email_failed" // invite: allowlisted, but the mail could not be sent
  | "search_limit" // destination search: daily runs used up (resetAt = next Berlin midnight)
  | "places_unavailable" // destination search: the geocoder is down, no place can be checked
  | "drive_unavailable" // drive search: no verified drive times (key missing, quota nearly used, ORS down)
  | "home_required" // drive search: no start place (none given, none saved with coordinates)
  | "places_pending" // places with a source did not load yet; retry or generate anyway
  | "invalid_credentials" // password login: wrong email, wrong password or no password (always the same)
  | "weak_password" // rejected by Supabase (too short, leaked-password protection)
  | "same_password" // new password equals the current one
  | "reauth_required" // "secure password change": sign in again, then retry
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
