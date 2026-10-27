/** Result of every server action. Actions return errors as data instead of throwing. */
export type ActionError =
  | "unauthenticated"
  | "invalid" // Zod validation failed, see `issues`
  | "not_found"
  | "unknown_airport"
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
