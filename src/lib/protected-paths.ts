import { routing } from "@/i18n/routing";

const PROTECTED_SEGMENTS = ["app", "settings"];

/** Returns the locale of a path if it is in a protected area (/[locale]/app/**, /[locale]/settings/**), else null. */
export function protectedAreaLocale(pathname: string): string | null {
  // Next.js routes on the decoded path, so match on decoded segments (/de/%61pp is /de/app).
  const [, locale, area] = pathname.split("/").map(decodeSegment);
  if (!(routing.locales as readonly string[]).includes(locale)) return null;
  return PROTECTED_SEGMENTS.includes(area) ? locale : null;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * A server action call from the client (fetch with the `Next-Action` header). It is not redirected to the login page:
 * the client cannot read an HTML answer ("An unexpected response was received from the server") and the action checks
 * the session itself (RLS applies as well), so a signed-out caller gets the action's own error result.
 */
export function isServerActionRequest(headers: Headers): boolean {
  return headers.has("next-action");
}
