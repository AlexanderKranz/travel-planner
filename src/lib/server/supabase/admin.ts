import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * SERVER-ONLY admin client using SUPABASE_SECRET_KEY. It BYPASSES RLS.
 *
 * Allowed uses: writing app_events / parsed_* / api_cache / ai_usage, account
 * deletion, the share-link reader, admin aggregates. Never use it to read or
 * write user content on behalf of a normal user request: use
 * createSupabaseServerClient() so RLS applies.
 */
export function createSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY");
  }
  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
