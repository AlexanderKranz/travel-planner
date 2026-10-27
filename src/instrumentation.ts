import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

// Reports unhandled errors from Server Components, route handlers and middleware.
// Handled errors that we log with logEvent() are NOT captured (we never enable
// captureConsole), so nothing is reported twice.
export const onRequestError = Sentry.captureRequestError;
