// Privacy scrubber for Sentry events (GDPR: family & friends app).
// Pure functions, no Sentry imports, so they are unit-testable.
// Removes email addresses and secrets from messages, URLs, query strings,
// breadcrumbs, request data and extra context. Keeps only the user id.

const REDACTED = "[redacted]";
const EMAIL = "[email]";

/** Keys whose value is always dropped, compared lowercase with "-" and "_" removed. */
const SENSITIVE_KEYS = new Set([
  "tokenhash",
  "token",
  "code",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "password",
  "passwd",
  "apikey",
  "secret",
  "authorization",
  "cookie",
  "setcookie",
  "cookies",
  "email",
]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Percent-encoded "@" (%40) inside URLs, e.g. ?email=a%40b.de
const ENCODED_EMAIL_RE = /[A-Za-z0-9._%+-]+%40[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi;
const PARAM_RE =
  /([?&;\s"']?)(token_hash|token|code|access_token|refresh_token|id_token|password|apikey|api_key|secret|email)=([^&\s"'#]*)/gi;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

export function scrubString(input: string): string {
  return input
    .replace(PARAM_RE, (_m, lead: string, key: string) => `${lead}${key}=${REDACTED}`)
    .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(ENCODED_EMAIL_RE, EMAIL)
    .replace(EMAIL_RE, EMAIL);
}

const MAX_DEPTH = 8;

/** Recursively scrubs strings and drops sensitive keys. Returns a new value. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEYS.has(normalizeKey(key)) ? REDACTED : scrubValue(v, depth + 1);
  }
  return out;
}

type Loose = Record<string, unknown>;

/**
 * Generic over the event type so it fits Sentry's ErrorEvent without importing it.
 * Mutates nothing; returns a scrubbed copy.
 */
export function scrubEvent<T extends object>(event: T): T {
  const e = { ...(event as Loose) };

  if (typeof e.message === "string") e.message = scrubString(e.message);
  if (typeof e.transaction === "string") e.transaction = scrubString(e.transaction);

  if (e.exception) e.exception = scrubValue(e.exception);
  if (e.breadcrumbs) e.breadcrumbs = scrubValue(e.breadcrumbs);
  if (e.extra) e.extra = scrubValue(e.extra);
  if (e.contexts) e.contexts = scrubValue(e.contexts);
  if (e.tags) e.tags = scrubValue(e.tags);

  if (e.request && typeof e.request === "object") {
    const r = { ...(e.request as Loose) };
    if (typeof r.url === "string") r.url = scrubString(r.url);
    if (typeof r.query_string === "string") r.query_string = scrubString(r.query_string);
    else if (r.query_string) r.query_string = scrubValue(r.query_string);
    // Request bodies and cookies are never needed to debug; drop them.
    delete r.data;
    delete r.cookies;
    r.headers = scrubValue(r.headers ?? {});
    delete (r.headers as Loose).cookie;
    delete (r.headers as Loose).Cookie;
    e.request = r;
  }

  // Only the opaque Supabase user id may stay. No email, username, IP.
  if (e.user && typeof e.user === "object") {
    const id = (e.user as Loose).id;
    e.user = typeof id === "string" ? { id } : undefined;
  }

  return e as T;
}

export function scrubBreadcrumb<T extends object>(breadcrumb: T): T {
  return scrubValue(breadcrumb) as T;
}
