import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fails closed: with no CRON_SECRET configured nothing
 * is authorised. Constant-time comparison of SHA-256 digests (no length leak).
 */
export function isCronAuthorized(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || !secret.trim() || !authorization) return false;
  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}
