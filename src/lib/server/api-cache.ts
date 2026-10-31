import "server-only";
import { z } from "zod";
import { logApiCalls, type ApiCallRow } from "./api-calls";
import { createSupabaseAdminClient } from "./supabase/admin";

export const CacheProvider = z.enum([
  "open_meteo_geocoding",
  "open_meteo_archive",
  "overpass",
  "wikivoyage",
  "wikipedia",
  "wikidata",
  "aerodatabox",
  "openrouteservice",
  "geoapify",
]);
export type CacheProvider = z.infer<typeof CacheProvider>;

const normalizeString = (s: string) => s.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Stable key: `${endpoint}:v${version}:` + params sorted by name, `k=v` joined by `;`.
 * Strings: NFC, trim, lowercase, collapse spaces. Numbers: as given (round coords before calling).
 */
export function cacheKey(
  endpoint: string,
  version: number,
  params: Record<string, string | number>,
): string {
  const parts = Object.keys(params)
    .sort()
    .map((name) => {
      const v = params[name];
      return `${name}=${typeof v === "string" ? normalizeString(v) : String(v)}`;
    });
  return `${endpoint}:v${version}:${parts.join(";")}`;
}

export type FetchOutcome<T> = {
  data: T;
  status: number;
  latencyMs: number;
  units?: number;
  quotaRemaining?: number;
  /** Which sub-source answered (Overpass mirror host), logged in api_calls.variant. */
  variant?: string;
};

export type CachedResult<T> =
  | { ok: true; data: T; fetchedAt: string; stale: boolean; cache: "hit" | "miss" | "stale" }
  | { ok: false; error: "provider_error" | "timeout" | "invalid_response" | "quota_exhausted" };

export type CacheCtx = { userId: string | null };

/** Payloads are stored as { v: data } because api_cache.payload is `jsonb not null` (null results must be cacheable). */
const Envelope = z.object({ v: z.unknown() });
/** Suffix on the stored key so rows written before the envelope existed are ignored. */
const ENVELOPE_KEY_SUFFIX = "#e1";

type CacheRow = { payload: unknown; fetched_at: string; expires_at: string };

/** Units the provider charged for a failed request (errors may carry `units`/`quotaRemaining`, e.g. AeroDataBox). */
function chargedOf(err: unknown): { units: number | null; quotaRemaining: number | null } {
  const e = err as { units?: unknown; quotaRemaining?: unknown } | null;
  return {
    units: typeof e?.units === "number" ? e.units : null,
    quotaRemaining: typeof e?.quotaRemaining === "number" ? e.quotaRemaining : null,
  };
}

/** Short, PII-free error class for api_calls.error_code and the CachedResult error. */
function classifyError(err: unknown): {
  code: string;
  status: number | null;
  error: "provider_error" | "timeout" | "invalid_response" | "quota_exhausted";
  units: number | null;
  quotaRemaining: number | null;
} {
  const base = chargedOf(err);
  if (err instanceof z.ZodError) return { code: "zod", status: null, error: "invalid_response", ...base };
  const e = err as { name?: unknown; status?: unknown } | null;
  const name = typeof e?.name === "string" ? e.name : "";
  if (name === "QuotaGuardError") return { code: "quota_guard", status: null, error: "quota_exhausted", ...base };
  if (name === "TimeoutError" || name === "AbortError") {
    return { code: "timeout", status: null, error: "timeout", ...base };
  }
  if (typeof e?.status === "number") {
    return { code: `http_${e.status}`, status: e.status, error: "provider_error", ...base };
  }
  return { code: "network", status: null, error: "provider_error", ...base };
}

/**
 * Read-through cache for external API calls (ground rule 8). Reads api_cache with the
 * secret key (the table has no user grants), fetches on miss/expiry, upserts, and writes
 * exactly one api_calls row. If the refresh fails and an expired row exists, that row is
 * served as stale. Errors are never cached. Never throws.
 */
export async function cached<T>(opts: {
  provider: CacheProvider;
  endpoint: string;
  key: string;
  ttlSeconds: number;
  /** Re-validates the cached payload (mismatch counts as a miss) and the fetched data. */
  schema: z.ZodType<T>;
  /** Throws on non-2xx / timeout / Zod error. */
  fetcher: () => Promise<FetchOutcome<T>>;
  ctx: CacheCtx;
  /**
   * Checked after a cache miss, right before fetching. `false` = no network call (time budget used up):
   * an expired row is served as stale, otherwise `timeout`. Nothing is logged then (no call was made).
   */
  fetchAllowed?: () => boolean;
}): Promise<CachedResult<T>> {
  const { provider, endpoint, key, ttlSeconds, schema, fetcher, ctx, fetchAllowed } = opts;
  const storeKey = `${key}${ENVELOPE_KEY_SUFFIX}`;
  const base = { provider, endpoint, userId: ctx.userId };
  const log = (row: Omit<ApiCallRow, "provider" | "endpoint" | "userId">) =>
    logApiCalls([{ ...base, ...row }]);

  try {
    const admin = createSupabaseAdminClient();

    // 1. Read. A read failure is treated as a miss (the cache is an optimisation).
    let existing: { data: T; fetchedAt: string; expiresAt: number } | null = null;
    try {
      const { data: row, error } = await admin
        .from("api_cache")
        .select("payload, fetched_at, expires_at")
        .eq("provider", provider)
        .eq("cache_key", storeKey)
        .maybeSingle<CacheRow>();
      if (error) console.error("api_cache read failed", error.code);
      if (row) {
        const env = Envelope.safeParse(row.payload);
        const parsed = env.success ? schema.safeParse(env.data.v) : null;
        if (parsed?.success) {
          existing = {
            data: parsed.data,
            fetchedAt: row.fetched_at,
            expiresAt: Date.parse(row.expires_at),
          };
        }
      }
    } catch (error) {
      console.error("api_cache read failed", error instanceof Error ? error.name : "unknown");
    }

    if (existing && existing.expiresAt > Date.now()) {
      await log({ cache: "hit", ok: true });
      return { ok: true, data: existing.data, fetchedAt: existing.fetchedAt, stale: false, cache: "hit" };
    }

    if (fetchAllowed && !fetchAllowed()) {
      return existing
        ? { ok: true, data: existing.data, fetchedAt: existing.fetchedAt, stale: true, cache: "stale" }
        : { ok: false, error: "timeout" };
    }

    // 2. Fetch.
    try {
      const outcome = await fetcher();
      const data = schema.parse(outcome.data);
      const now = new Date();
      const fetchedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
      const { error } = await admin.from("api_cache").upsert(
        { provider, cache_key: storeKey, payload: { v: data } as never, fetched_at: fetchedAt, expires_at: expiresAt },
        { onConflict: "provider,cache_key" },
      );
      if (error) console.error("api_cache write failed", error.code);
      await log({
        cache: "miss",
        ok: true,
        status: outcome.status,
        latencyMs: outcome.latencyMs,
        units: outcome.units ?? null,
        quotaRemaining: outcome.quotaRemaining ?? null,
        variant: outcome.variant ?? null,
      });
      return { ok: true, data, fetchedAt, stale: false, cache: "miss" };
    } catch (err) {
      const c = classifyError(err);
      if (existing) {
        await log({ cache: "stale", ok: false, status: c.status, errorCode: c.code, units: c.units, quotaRemaining: c.quotaRemaining });
        return { ok: true, data: existing.data, fetchedAt: existing.fetchedAt, stale: true, cache: "stale" };
      }
      await log({ cache: "miss", ok: false, status: c.status, errorCode: c.code, units: c.units, quotaRemaining: c.quotaRemaining });
      return { ok: false, error: c.error };
    }
  } catch (error) {
    console.error("cached() failed", error instanceof Error ? error.name : "unknown");
    return { ok: false, error: "provider_error" };
  }
}

/**
 * Cache-only read for the public share path (ADR 0005: no external calls while rendering a shared plan).
 * Returns the stored value even if expired (a stale picture beats none), `undefined` on miss, schema mismatch or
 * read error. Writes nothing and logs nothing. Never throws.
 */
export async function peekCache<T>(opts: {
  provider: CacheProvider;
  key: string;
  schema: z.ZodType<T>;
}): Promise<{ data: T; fetchedAt: string } | undefined> {
  try {
    const { data: row, error } = await createSupabaseAdminClient()
      .from("api_cache")
      .select("payload, fetched_at")
      .eq("provider", opts.provider)
      .eq("cache_key", `${opts.key}${ENVELOPE_KEY_SUFFIX}`)
      .maybeSingle<{ payload: unknown; fetched_at: string }>();
    if (error || !row) return undefined;
    const env = Envelope.safeParse(row.payload);
    const parsed = env.success ? opts.schema.safeParse(env.data.v) : null;
    return parsed?.success ? { data: parsed.data, fetchedAt: row.fetched_at } : undefined;
  } catch {
    return undefined;
  }
}
