import "server-only";
// SERVER-ONLY secret-key client. Deleting an auth user is not possible with RLS-bound clients; everything the
// user owns cascades via the owner_id foreign keys (app_events.user_id is set to null).
import { createSupabaseAdminClient } from "./supabase/admin";

export type RemoveUserResult = { ok: true } | { ok: false; step: "allowlist" | "delete"; status: number | null };

/**
 * Shared by self-service account deletion and admin deletion. The caller has already decided that this user may be
 * deleted (demo/admin/self guards) and logs the outcome; the id must come from a verified session or a validated
 * admin input, never from raw client data.
 *
 * Order: the invite goes first (a deleted user needs a NEW invite to come back), then the auth user. The email is
 * read from the auth user and never logged. If the allowlist step fails, the user is NOT deleted.
 */
export async function removeUserAccount(userId: string): Promise<RemoveUserResult> {
  const admin = createSupabaseAdminClient();
  const { data: authUser } = await admin.auth.admin.getUserById(userId);
  const email = authUser?.user?.email;
  if (email) {
    const { error } = await admin.from("signup_allowlist").delete().eq("email", email.trim().toLowerCase());
    if (error) return { ok: false, step: "allowlist", status: null };
  }
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) return { ok: false, step: "delete", status: error.status ?? null };
  return { ok: true };
}
