import "server-only";

/**
 * Base URL of this deployment for links we put into emails. NEVER derived from request headers
 * (Host / X-Forwarded-Host are attacker-controlled). Order: APP_URL, Vercel production domain,
 * localhost in development. Returns null if nothing is configured (e.g. preview without APP_URL).
 */
export function getAppUrl(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = env.APP_URL?.trim();
  if (explicit) {
    try {
      const url = new URL(explicit);
      if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
    } catch {
      // fall through to the other sources
    }
  }
  const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (env.VERCEL_ENV === "production" && vercelHost) {
    try {
      return new URL(`https://${vercelHost}`).origin;
    } catch {
      return null;
    }
  }
  if (env.NODE_ENV === "development") return "http://localhost:3000";
  return null;
}
