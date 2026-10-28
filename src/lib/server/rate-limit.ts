import "server-only";

/**
 * Fixed-window rate limiter, in memory per server instance.
 * Limitation: on Vercel every lambda instance has its own counters, so the effective limit is
 * `limit` per instance (roughly limit x warm instances). Good enough to stop a single user
 * hammering a free-tier upstream; replace with a Postgres/Redis counter if strict limits are needed.
 */
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 5000;

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): { ok: boolean; retryAfterSeconds: number } {
  if (buckets.size >= MAX_BUCKETS) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    if (buckets.size >= MAX_BUCKETS) buckets.clear(); // memory guard
  }
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSeconds: 0 };
  }
  if (b.count >= limit) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  b.count += 1;
  return { ok: true, retryAfterSeconds: 0 };
}

/** Test helper. */
export function resetRateLimits(): void {
  buckets.clear();
}
