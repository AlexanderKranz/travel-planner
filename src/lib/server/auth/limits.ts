import "server-only";
import { headers } from "next/headers";
import { clientIp } from "../client-ip";
import { rateLimit } from "../rate-limit";

const WINDOW_MS = 600_000; // 10 minutes

/**
 * Limits for the unauthenticated auth actions. They protect the shared mail quota (the built-in Supabase sender
 * allows only a few emails per hour, so a script could otherwise lock everybody out) and the 6-digit code against
 * guessing. Keys depend only on the input and the caller, never on whether an address is invited, so the neutral
 * login answer stays neutral. In-memory per instance, see docs/specs/phase-6-hardening.md D2.
 */
const LIMITS = {
  login: { ip: 10, email: 3 }, // sign-in mail requests per 10 min
  code: { ip: 30, email: 10 }, // code attempts per 10 min (1 in 10^6 per guess)
  demo: { ip: 20, email: 0 },
} as const;

export async function authAllowed(kind: keyof typeof LIMITS, email?: string): Promise<boolean> {
  const l = LIMITS[kind];
  const ip = clientIp(await headers());
  if (ip && !rateLimit(`auth-${kind}-ip:${ip}`, l.ip, WINDOW_MS).ok) return false;
  if (email && l.email > 0 && !rateLimit(`auth-${kind}-email:${email.toLowerCase()}`, l.email, WINDOW_MS).ok) return false;
  return true;
}
