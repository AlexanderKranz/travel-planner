import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicEnv } from "@/lib/supabase/env";

const DB_TIMEOUT_MS = 3000;

/** DB reachability through the Data API with the publishable key only (public.health_check() reads no table). */
export async function checkDb(): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();
  try {
    const { url, publishableKey } = getSupabasePublicEnv();
    const supabase = createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await supabase.rpc("health_check").abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    return { ok: !error, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  }
}
