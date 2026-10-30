"use server";

import { redirect } from "next/navigation";
import { Locale } from "@/lib/domain/profile";
import { fail, type ActionResult } from "@/lib/domain/result";
import { logEvent } from "./events";
import { getUserSession } from "./session";
import { removeUserAccount } from "./user-removal";

/**
 * Deletes the signed-in user's account and all their data (FK cascade), then
 * redirects to the public home page. The UI must ask for confirmation first.
 * The user id comes from the verified session, never from the client.
 */
export async function deleteAccount(locale: string): Promise<ActionResult> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const safeLocale = Locale.catch("de").parse(locale);

  // The shared demo account is never deleted. Fail closed: if the flag cannot be read, refuse.
  const { data: flag, error: flagError } = await session.supabase
    .from("profiles")
    .select("is_demo")
    .eq("id", session.userId)
    .maybeSingle();
  if (flagError || !flag || flag.is_demo) {
    if (flag?.is_demo) {
      await logEvent({ event: "account.delete_blocked_demo", level: "warn", userId: session.userId });
    }
    return fail("failed");
  }

  // Invite removal + user deletion are shared with the admin delete action. The id is the verified session's.
  const removed = await removeUserAccount(session.userId);
  if (!removed.ok) {
    await logEvent({
      event: "error.account_delete",
      level: "error",
      userId: session.userId,
      props: removed.step === "allowlist" ? { step: "allowlist" } : { status: removed.status },
    });
    return fail("failed");
  }
  // user_id on app_events is set to null by the FK, so the event carries no identity.
  await logEvent({ event: "account.deleted" });
  try {
    await session.supabase.auth.signOut({ scope: "local" });
  } catch {
    // The user no longer exists; clearing cookies is best effort.
  }
  redirect(`/${safeLocale}`);
}
