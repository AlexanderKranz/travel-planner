import "server-only";
import { createSupabaseServerClient } from "./supabase/server";

/**
 * Supabase client on behalf of the current user (RLS applies) plus the verified
 * user id, or null when signed out. Uses getClaims() (local JWT verification).
 */
export async function getUserSession() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (typeof userId !== "string") return null;
  return { supabase, userId };
}

export const todayIso = () => new Date().toISOString().slice(0, 10);
