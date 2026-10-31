"use server";

import {
  AdminUserInput,
  isManageable,
  type AdminUserEntry,
} from "@/lib/domain/admin-user";
import { fail, zodIssues, type ActionResult } from "@/lib/domain/result";
import { logEvent } from "../events";
import { createSupabaseAdminClient } from "../supabase/admin";
import { removeUserAccount } from "../user-removal";
import { getAdminSession } from "./gate";

/**
 * User management (admin only): list, disable, enable, delete.
 *
 * Permission: getAdminSession() (role read through the admin's own RLS session). The target is only an id, validated
 * with Zod; self / demo / admin flags are read from the database here, never taken from the client.
 * The secret-key client is used for what RLS deliberately forbids: reading other users' profile flags, writing
 * profiles.disabled_at (not user-writable), and the Auth admin API (ban, list, delete). It reads account facts only,
 * never trips, groups, notes or plans. Events carry the acting admin's id and no target identity, no emails.
 *
 * Disabling is two steps, because a ban alone does not end an already issued access token (getUserSession() verifies
 * the JWT locally): (1) profiles.disabled_at, enforced by getUserSession() at once, (2) the Auth ban, which stops
 * token refresh and new sign-ins. A failed second step is rolled back; if even the rollback fails, the account stays
 * disabled (the safe direction) and an error event says so.
 */

const BAN_FOREVER = "876000h"; // about 100 years; Supabase has no "permanent" value
const MAX_USER_PAGES = 10; // 2000 users

type TargetCheck = { ok: true } | { ok: false; error: "not_found" | "protected" | "failed" };

/** Server-side guards shared by all three actions. Fails closed when the target's role cannot be read. */
async function checkTarget(adminId: string, userId: string): Promise<TargetCheck> {
  if (userId === adminId) return { ok: false, error: "protected" };
  const { data, error } = await createSupabaseAdminClient()
    .from("profiles")
    .select("role, is_demo")
    .eq("id", userId)
    .maybeSingle<{ role: string | null; is_demo: boolean | null }>();
  if (error) return { ok: false, error: "failed" };
  if (!data) return { ok: false, error: "not_found" };
  if (!isManageable({ isSelf: false, role: data.role, isDemo: data.is_demo })) return { ok: false, error: "protected" };
  return { ok: true };
}

async function setDisabledAt(userId: string, value: string | null): Promise<boolean> {
  const { error } = await createSupabaseAdminClient().from("profiles").update({ disabled_at: value }).eq("id", userId);
  return !error;
}

async function guarded(
  input: unknown,
): Promise<{ ok: true; adminId: string; userId: string } | { ok: false; result: ReturnType<typeof fail> }> {
  const session = await getAdminSession();
  if (!session) return { ok: false, result: fail("forbidden") };
  const parsed = AdminUserInput.safeParse(input);
  if (!parsed.success) return { ok: false, result: fail("invalid", zodIssues(parsed.error)) };
  const check = await checkTarget(session.userId, parsed.data.userId);
  if (!check.ok) return { ok: false, result: fail(check.error) };
  return { ok: true, adminId: session.userId, userId: parsed.data.userId };
}

export async function listUsers(): Promise<ActionResult<AdminUserEntry[]>> {
  const session = await getAdminSession();
  if (!session) return fail("forbidden");
  const admin = createSupabaseAdminClient();
  try {
    const users: { id: string; email?: string | null; last_sign_in_at?: string | null; banned_until?: string | null }[] = [];
    for (let page = 1; page <= MAX_USER_PAGES; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) return fail("failed");
      users.push(...data.users);
      if (data.users.length < 200) break;
    }
    const { data: profiles, error } = await admin
      .from("profiles")
      .select("id, role, is_demo, disabled_at")
      .limit(MAX_USER_PAGES * 200)
      .returns<{ id: string; role: string | null; is_demo: boolean | null; disabled_at: string | null }[]>();
    if (error) return fail("failed");
    const byId = new Map(profiles.map((p) => [p.id, p]));
    const now = Date.now();
    const entries = users
      .filter((u) => u.email)
      .map((u): AdminUserEntry => {
        const p = byId.get(u.id);
        const isSelf = u.id === session.userId;
        const banned = !!u.banned_until && Date.parse(u.banned_until) > now;
        return {
          id: u.id,
          email: u.email as string,
          status: p?.disabled_at || banned ? "disabled" : "active",
          lastSignInAt: u.last_sign_in_at ?? null,
          isSelf,
          isAdmin: p?.role === "admin",
          isDemo: p?.is_demo === true,
          manageable: isManageable({ isSelf, role: p?.role ?? null, isDemo: p ? p.is_demo : null }),
        };
      })
      .sort((a, b) => a.email.localeCompare(b.email));
    return { ok: true, data: entries };
  } catch {
    return fail("failed");
  }
}

export async function disableUser(input: { userId: string }): Promise<ActionResult> {
  const g = await guarded(input);
  if (!g.ok) return g.result;
  // Step 1: the flag, which ends the user's current session at once.
  if (!(await setDisabledAt(g.userId, new Date().toISOString()))) return fail("failed");
  // Step 2: the Auth ban (no refresh, no new sign-in). Roll step 1 back if it fails, never half-apply silently.
  const { error } = await createSupabaseAdminClient().auth.admin.updateUserById(g.userId, { ban_duration: BAN_FOREVER });
  if (error) {
    const rolledBack = await setDisabledAt(g.userId, null);
    await logEvent({
      event: "error.user_disable",
      level: "error",
      userId: g.adminId,
      route: "action:disableUser",
      // rolledBack=false: flag stays set, so the account IS disabled but not banned; run Disable again or Enable.
      props: { step: "ban", rolledBack, status: error.status ?? null },
    });
    return fail("failed");
  }
  await logEvent({ event: "admin.user_disabled", userId: g.adminId, route: "action:disableUser" });
  return { ok: true };
}

export async function enableUser(input: { userId: string }): Promise<ActionResult> {
  const g = await guarded(input);
  if (!g.ok) return g.result;
  const admin = createSupabaseAdminClient();
  // Reverse order: lift the ban first, then clear the flag. The user can only sign in again once both are done.
  const { error } = await admin.auth.admin.updateUserById(g.userId, { ban_duration: "none" });
  if (error) {
    await logEvent({
      event: "error.user_enable",
      level: "error",
      userId: g.adminId,
      route: "action:enableUser",
      props: { step: "unban", status: error.status ?? null },
    });
    return fail("failed");
  }
  if (!(await setDisabledAt(g.userId, null))) {
    // Flag still set: re-ban so ban and flag agree (both "disabled"). Report failure.
    const { error: reban } = await admin.auth.admin.updateUserById(g.userId, { ban_duration: BAN_FOREVER });
    await logEvent({
      event: "error.user_enable",
      level: "error",
      userId: g.adminId,
      route: "action:enableUser",
      props: { step: "flag", rebanned: !reban },
    });
    return fail("failed");
  }
  await logEvent({ event: "admin.user_enabled", userId: g.adminId, route: "action:enableUser" });
  return { ok: true };
}

/** Deletes the account and, by FK cascade, all of the user's data permanently. app_events.user_id becomes null. */
export async function deleteUserAsAdmin(input: { userId: string }): Promise<ActionResult> {
  const g = await guarded(input);
  if (!g.ok) return g.result;
  const removed = await removeUserAccount(g.userId);
  if (!removed.ok) {
    await logEvent({
      event: "error.user_delete",
      level: "error",
      userId: g.adminId,
      route: "action:deleteUserAsAdmin",
      props: { step: removed.step, status: removed.status },
    });
    return fail("failed");
  }
  await logEvent({ event: "admin.user_deleted", userId: g.adminId, route: "action:deleteUserAsAdmin" });
  return { ok: true };
}
