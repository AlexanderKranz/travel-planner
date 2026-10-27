"use server";

import { redirect } from "next/navigation";
import { Locale } from "@/lib/domain/profile";
import { fail, type ActionResult } from "@/lib/domain/result";
import { logEvent } from "./events";
import { getUserSession } from "./session";
// SERVER-ONLY secret-key client. Deleting an auth user is not possible with RLS-bound
// clients; everything the user owns cascades via the owner_id foreign keys.
import { createSupabaseAdminClient } from "./supabase/admin";

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

  const admin = createSupabaseAdminClient();
  // Remove the invite too (S2): a deleted user needs a NEW invite to come back. The email is read
  // from the auth user of the verified session id (never from client input) and never logged.
  const { data: authUser } = await admin.auth.admin.getUserById(session.userId);
  const email = authUser?.user?.email;
  if (email) {
    const { error: allowlistError } = await admin
      .from("signup_allowlist")
      .delete()
      .eq("email", email.trim().toLowerCase());
    if (allowlistError) {
      await logEvent({
        event: "error.account_delete",
        level: "error",
        userId: session.userId,
        props: { step: "allowlist" },
      });
      return fail("failed");
    }
  }
  const { error } = await admin.auth.admin.deleteUser(session.userId);
  if (error) {
    await logEvent({
      event: "error.account_delete",
      level: "error",
      userId: session.userId,
      props: { status: error.status ?? null },
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
