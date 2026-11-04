import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TripPurposeParsed } from "@/lib/domain/purpose";

/**
 * Shared by `createPurpose` (purposes.ts) and "Save as purpose" from a typed search (discover/save-purpose.ts).
 * Lives outside purposes.ts on purpose: that file is "use server", so every export would become a callable action.
 */

export const PURPOSE_COLUMNS = "id, name, text, guided, constraints, parsed_tags, parsed_hash, created_at, updated_at";

export type PurposeRow = {
  id: string;
  name: string;
  text: string | null;
  guided: unknown;
  constraints: string[];
  parsed_tags: unknown;
  parsed_hash: string | null;
  created_at: string;
  updated_at: string;
};

/** Inserts one purpose with the USER session. owner_id is filled by its column default (auth.uid()); RLS checks it. */
export async function insertPurposeRow(
  sb: SupabaseClient,
  input: TripPurposeParsed,
): Promise<{ data: PurposeRow; error: null } | { data: null; error: { code?: string } }> {
  const { data, error } = await sb
    .from("trip_purposes")
    .insert({ name: input.name, text: input.text ?? null, guided: input.guided, constraints: input.constraints })
    .select(PURPOSE_COLUMNS)
    .single<PurposeRow>();
  return error || !data ? { data: null, error: error ?? {} } : { data, error: null };
}
