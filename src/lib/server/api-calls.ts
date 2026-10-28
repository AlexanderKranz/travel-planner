import "server-only";
import { createSupabaseAdminClient } from "./supabase/admin";

export type ApiCallRow = {
  provider: string;
  /** Logical endpoint name (`search`, `archive`, ...): `^[a-z0-9_]+$`. */
  endpoint: string;
  cache: "hit" | "miss" | "stale" | "bypass";
  status?: number | null;
  ok: boolean;
  latencyMs?: number | null;
  units?: number | null;
  quotaRemaining?: number | null;
  /** Short class only (`timeout`, `http_429`, `zod`, `network`). */
  errorCode?: string | null;
  userId?: string | null;
};

/**
 * Batched insert into api_calls with the secret key (RLS bypass is intended: only the
 * server writes this table). Rows carry metadata only: never cache keys, query text,
 * coordinates or API keys. Never throws: logging must not break a request.
 */
export async function logApiCalls(rows: ApiCallRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    const admin = createSupabaseAdminClient();
    const { error } = await admin.from("api_calls").insert(
      rows.map((r) => ({
        provider: r.provider,
        endpoint: r.endpoint,
        cache: r.cache,
        status: r.status ?? null,
        ok: r.ok,
        latency_ms: r.latencyMs ?? null,
        units: r.units ?? null,
        quota_remaining: r.quotaRemaining ?? null,
        error_code: r.errorCode ? r.errorCode.slice(0, 60) : null,
        user_id: r.userId ?? null,
      })),
    );
    if (error) console.error("logApiCalls failed", error.code);
  } catch (error) {
    console.error("logApiCalls failed", error instanceof Error ? error.name : "unknown");
  }
}
