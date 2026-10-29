"use server";

import { fail, zodIssues, type ActionResult } from "@/lib/domain/result";
import { InviteInput, InviteRevokeInput, inviteStatus, type InviteEntry } from "@/lib/domain/invite";
import { getAppUrl } from "../app-url";
import { logEvent } from "../events";
import { rateLimit } from "../rate-limit";
import { createSupabaseAdminClient } from "../supabase/admin";
import { getAdminSession } from "./gate";

/**
 * Invite management (admin only). The allowlist (`signup_allowlist`) is the gate: it is read and written with the
 * admin's own session, so RLS (private.is_admin()) enforces the permission a second time. The secret-key client is
 * used only for the Auth admin API (send the invite mail, look up last sign-ins, delete a never-used account), which
 * has no RLS-governed equivalent. Emails appear here and nowhere else: the admin entered them himself.
 * No email address is ever written to app_events or Sentry.
 */

const INVITES_PER_HOUR = 10; // per admin; Supabase's built-in sender allows far fewer, see runbook
const MAX_USER_PAGES = 10; // 2000 users; far above the family/friends scale this app is built for
const NOTE = "invited by admin";

type AllowlistRow = { id: number; email: string; note: string | null; created_at: string };
type AuthUserLite = { id: string; email?: string | null; last_sign_in_at?: string | null };

async function lookupUsers(): Promise<Map<string, AuthUserLite>> {
  const admin = createSupabaseAdminClient();
  const byEmail = new Map<string, AuthUserLite>();
  for (let page = 1; page <= MAX_USER_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error("list users failed");
    for (const u of data.users) if (u.email) byEmail.set(u.email.toLowerCase(), u);
    if (data.users.length < 200) break;
  }
  return byEmail;
}

/** The demo account's allowlist row is plumbing, not an invite. */
function isDemoEmail(email: string): boolean {
  const demo = process.env.DEMO_EMAIL?.trim().toLowerCase();
  return !!demo && email === demo;
}

export async function listInvites(): Promise<ActionResult<InviteEntry[]>> {
  const session = await getAdminSession();
  if (!session) return fail("forbidden");
  const { data, error } = await session.supabase
    .from("signup_allowlist")
    .select("id, email, note, created_at")
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<AllowlistRow[]>();
  if (error) return fail("failed");
  let users: Map<string, AuthUserLite>;
  try {
    users = await lookupUsers();
  } catch {
    return fail("failed");
  }
  const entries = data
    .filter((r) => !isDemoEmail(r.email.toLowerCase()))
    .map((r): InviteEntry => {
      const u = users.get(r.email.toLowerCase());
      const status = inviteStatus(u?.last_sign_in_at);
      return { id: r.id, email: r.email, note: r.note, createdAt: r.created_at, status, revocable: status === "pending" };
    });
  return { ok: true, data: entries };
}

/** Message class of Supabase's "user exists" answer (HTTP 422, code email_exists / user_already_exists). */
function isAlreadyRegistered(error: { status?: number; code?: string; message?: string }): boolean {
  return (
    error.code === "email_exists" ||
    error.code === "user_already_exists" ||
    /already.*registered|already exists/i.test(error.message ?? "")
  );
}

export async function inviteUser(input: { email: string; locale: string }): Promise<ActionResult> {
  const session = await getAdminSession();
  if (!session) return fail("forbidden");
  const parsed = InviteInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));
  const { email, locale } = parsed.data;

  if (!rateLimit(`invite:${session.userId}`, INVITES_PER_HOUR, 3_600_000).ok) {
    return fail("rate_limited");
  }

  // 1. Allowlist first: this alone lets the person sign in from the login page (works with any mail sender).
  const ins = await session.supabase.from("signup_allowlist").insert({ email, note: NOTE });
  if (ins.error && ins.error.code !== "23505") return fail("failed"); // 23505: already listed, resend the mail

  // 2. Invite mail. One redirect URL serves both templates (see docs/specs/phase-6-hardening.md D9).
  const origin = getAppUrl();
  const admin = createSupabaseAdminClient();
  const { error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { locale }, // read by the signup trigger for the profile locale
    ...(origin ? { redirectTo: `${origin}/auth/confirm?locale=${locale}&invited=1` } : {}),
  });
  if (error) {
    if (isAlreadyRegistered(error)) {
      await logEvent({ event: "admin.invite_existing", userId: session.userId, route: "action:inviteUser" });
      return fail("already_member");
    }
    // Includes Supabase's hourly mail limit (429 / over_email_send_rate_limit). The allowlist row stays.
    await logEvent({
      event: "admin.invite_mail_failed",
      level: "warn",
      userId: session.userId,
      route: "action:inviteUser",
      props: { status: error.status ?? null, code: error.code ?? null },
    });
    return fail("email_failed");
  }
  await logEvent({ event: "admin.invite_sent", userId: session.userId, route: "action:inviteUser" });
  return { ok: true };
}

export async function revokeInvite(input: { id: number }): Promise<ActionResult> {
  const session = await getAdminSession();
  if (!session) return fail("forbidden");
  const parsed = InviteRevokeInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));

  const row = await session.supabase
    .from("signup_allowlist")
    .select("id, email")
    .eq("id", parsed.data.id)
    .maybeSingle<{ id: number; email: string }>();
  if (row.error) return fail("failed");
  if (!row.data) return fail("not_found");
  const email = row.data.email.toLowerCase();
  if (isDemoEmail(email)) return fail("forbidden");

  // Never-used account first, so a failure leaves the allowlist row (and the retry button) in place.
  let removedUser = false;
  try {
    const user = (await lookupUsers()).get(email);
    if (user?.last_sign_in_at) return fail("conflict"); // accepted in the meantime; accounts are not revoked here
    if (user) {
      const { error } = await createSupabaseAdminClient().auth.admin.deleteUser(user.id);
      if (error) return fail("failed");
      removedUser = true;
    }
  } catch {
    return fail("failed");
  }

  const del = await session.supabase.from("signup_allowlist").delete().eq("id", parsed.data.id);
  if (del.error) return fail("failed");
  await logEvent({
    event: "admin.invite_revoked",
    userId: session.userId,
    route: "action:revokeInvite",
    props: { removedUser },
  });
  return { ok: true };
}
