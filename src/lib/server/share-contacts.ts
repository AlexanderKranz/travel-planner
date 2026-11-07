import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Person } from "@/lib/domain/sharing";

type ContactRow = { user_id: string; display_name: string | null; email: string };

/**
 * Name and email of every counterpart of the caller's share rows (`share_contacts`, user session). Users linked to
 * entries of the caller's own groups come with a display name and an empty email unless they are also a share
 * counterpart (docs/specs/group-sharing.md 2.9). Null when the call failed.
 */
export async function loadContacts(sb: SupabaseClient): Promise<Map<string, Person> | null> {
  const { data, error } = await sb.rpc("share_contacts");
  if (error) return null;
  return new Map(
    ((data ?? []) as ContactRow[]).map((c) => [c.user_id, { id: c.user_id, name: c.display_name, email: c.email }]),
  );
}

export const personOf = (contacts: Map<string, Person>, id: string): Person => contacts.get(id) ?? { id, name: null, email: "" };
