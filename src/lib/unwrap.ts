import { notFound } from "next/navigation";
import { redirect } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";

/** Unwraps an ActionResult in a Server Component page: signed out -> login, missing -> 404. */
export function unwrap<T>(
  result: { ok: true; data: T } | { ok: false; error: ActionError },
  locale: string,
): T {
  if (result.ok) return result.data;
  if (result.error === "unauthenticated") redirect({ href: "/login", locale });
  if (result.error === "not_found" || result.error === "invalid") notFound();
  throw new Error(`Action failed: ${result.error}`);
}
