import "server-only";
import { cache } from "react";
import { createSupabaseServerClient } from "./supabase/server";

/**
 * Supabase client on behalf of the current user (RLS applies) plus the verified
 * user id, or null when signed out. Uses getClaims() (local JWT verification).
 *
 * A disabled user (profiles.disabled_at, set by an admin) is treated as signed out. This is needed because
 * getClaims() never asks Supabase Auth: a ban stops token refresh and new sign-ins, but an access token that was
 * already issued stays valid until it expires (up to about 1 h). The one extra profile read runs once per request
 * (React `cache`).
 *
 * Lookup failure fails OPEN (the user stays signed in): every page and action behind this needs the same database
 * right after, so a real outage fails anyway, while failing closed would sign every user out on one transient
 * error. The exposure is bounded: the Auth ban already prevents the disabled user from refreshing their token.
 *
 * Limit: a client that calls PostgREST directly with a still-valid access token bypasses this check until the token
 * expires (about 1 h at most). RLS policies are deliberately not reworked for this.
 */
export const getUserSession = cache(async () => {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (typeof userId !== "string") return null;
  try {
    const { data: row, error } = await supabase
      .from("profiles")
      .select("disabled_at")
      .eq("id", userId)
      .maybeSingle<{ disabled_at: string | null }>();
    if (error) console.error("disabled check failed", error.code ?? "unknown");
    else if (row?.disabled_at) return null;
  } catch {
    console.error("disabled check failed");
  }
  return { supabase, userId };
});

export const todayIso = () => new Date().toISOString().slice(0, 10);
