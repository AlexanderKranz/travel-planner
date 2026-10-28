/** Client IP for in-memory rate-limit keys only, or null when no proxy header is present (skip the per-IP limit then). */
export function clientIp(h: { get(name: string): string | null }): string | null {
  const first = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return first || h.get("x-real-ip")?.trim() || null;
}
