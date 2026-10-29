// Shared Sentry options for client, server and edge.
// Docs checked 2026-10-28:
//   https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
//   https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/build/
// Sentry is OFF unless NEXT_PUBLIC_SENTRY_DSN is set (init is skipped entirely).
import { scrubBreadcrumb, scrubEvent } from "./sentry-scrub";

export function sentryEnvironment(): string {
  // Server/edge read VERCEL_ENV; the browser gets it via next.config.ts (env).
  return process.env.VERCEL_ENV ?? "development";
}

export function sentryDsn(): string | undefined {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  return dsn ? dsn : undefined;
}

/**
 * Browser messages for a fetch that was cut off (page change, phone asleep, connection lost): Safari, Chrome,
 * Firefox. Not app bugs; real server failures are reported by the server side and app_events.
 */
export const NETWORK_ABORT_ERRORS = [
  /^(TypeError: )?Load failed$/,
  /^(TypeError: )?Failed to fetch$/,
  /^(TypeError: )?NetworkError when attempting to fetch resource\.?$/,
];

export function buildSentryOptions() {
  const environment = sentryEnvironment();
  return {
    dsn: sentryDsn(),
    enabled: Boolean(sentryDsn()),
    environment,
    release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
    // Privacy: no IPs/cookies/headers by default, no replay, no profiling.
    sendDefaultPii: false,
    // Errors only. Performance tracing is off to stay inside the free tier.
    tracesSampleRate: 0,
    ignoreErrors: ["NEXT_REDIRECT", "NEXT_NOT_FOUND", ...NETWORK_ABORT_ERRORS],
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}
