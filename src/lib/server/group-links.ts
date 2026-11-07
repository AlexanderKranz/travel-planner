"use server";

import { EntryLinkInput } from "@/lib/domain/group";
import { fail, zodIssues, type ActionError, type ActionResult } from "@/lib/domain/result";
import { logEvent } from "./events";
import { getUserSession } from "./session";

/**
 * "That's me" on a group entry (docs/specs/group-sharing.md 1.3 and 3.2). Both actions call a database function with the
 * USER session: `claim_group_entry` / `unclaim_group_entry` take `auth.uid()` and check visibility, eligibility and the
 * one-claim rule themselves, so no secret key is needed here. Events carry ids only, never names (the entry's name and the
 * linked person stay out of `app_events`).
 */

/** Messages the functions raise with errcode P0001 and the ActionError each one becomes (`not_eligible` is `invalid`). */
const LINK_ERRORS: Record<string, ActionError> = {
  not_found: "not_found",
  forbidden: "forbidden",
  not_eligible: "invalid",
  already_linked: "already_linked",
  already_claimed: "already_claimed",
};

const UNIQUE_VIOLATION = "23505"; // group_entries_one_link_idx (claim maps it itself; kept as a safety net)

function mapLinkError(error: { code?: string; message?: string }): ActionError {
  if (error.code === UNIQUE_VIOLATION) return "already_claimed";
  return (error.code === "P0001" && error.message ? LINK_ERRORS[error.message] : undefined) ?? "failed";
}

/** The viewer says "That's me" on an entry of a group they can see (group share or shared trip). Returns the group id. */
export async function claimGroupEntry(input: EntryLinkInput): Promise<ActionResult<{ groupId: string }>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const parsed = EntryLinkInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));

  const { data, error } = await session.supabase.rpc("claim_group_entry", { p_entry_id: parsed.data.entryId });
  if (error) return fail(mapLinkError(error));
  if (typeof data !== "string") return fail("failed");
  await logEvent({ event: "sharing.entry_linked", userId: session.userId, props: { groupId: data } });
  return { ok: true, data: { groupId: data } };
}

/** "That's not me" (the linked user) or "Remove link" (the group owner). Returns the group id. */
export async function unclaimGroupEntry(input: EntryLinkInput): Promise<ActionResult<{ groupId: string }>> {
  const session = await getUserSession();
  if (!session) return fail("unauthenticated");
  const parsed = EntryLinkInput.safeParse(input);
  if (!parsed.success) return fail("invalid", zodIssues(parsed.error));

  const { data, error } = await session.supabase.rpc("unclaim_group_entry", { p_entry_id: parsed.data.entryId });
  if (error) return fail(mapLinkError(error));
  // The function returns a table (group_id, by_owner): read the first row.
  const row = (Array.isArray(data) ? data[0] : data) as { group_id?: unknown; by_owner?: unknown } | null | undefined;
  if (!row || typeof row.group_id !== "string") return fail("failed");
  await logEvent({
    event: "sharing.entry_unlinked",
    userId: session.userId,
    props: { groupId: row.group_id, by: row.by_owner === true ? "owner" : "self" },
  });
  return { ok: true, data: { groupId: row.group_id } };
}
