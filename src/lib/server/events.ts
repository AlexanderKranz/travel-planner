import "server-only";
import { createSupabaseAdminClient } from "./supabase/admin";

export type AppEventInput = {
  /** Dotted name, e.g. "auth.signup_rejected". */
  event: string;
  level?: "info" | "warn" | "error";
  userId?: string | null;
  route?: string;
  requestId?: string;
  /** Metadata only: ids, counts, durations, error classes. Never names, notes, text or emails. */
  props?: Record<string, string | number | boolean | null>;
};

/**
 * Writes to app_events with the secret key (RLS bypass is intended: only the
 * server writes this table). Never throws: logging must not break a request.
 */
export async function logEvent(input: AppEventInput): Promise<void> {
  try {
    const admin = createSupabaseAdminClient();
    const { error } = await admin.from("app_events").insert({
      event: input.event,
      level: input.level ?? "info",
      user_id: input.userId ?? null,
      route: input.route ?? null,
      request_id: input.requestId ?? null,
      props: input.props ?? {},
    });
    if (error) console.error("logEvent failed", input.event, error.code);
  } catch (error) {
    console.error("logEvent failed", input.event, error instanceof Error ? error.name : "unknown");
  }
}
