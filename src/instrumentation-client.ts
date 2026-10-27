// Browser-side Sentry. No-op without NEXT_PUBLIC_SENTRY_DSN.
// No Replay and no Feedback integration on purpose (privacy).
import * as Sentry from "@sentry/nextjs";
import { buildSentryOptions } from "@/lib/sentry-options";

const options = buildSentryOptions();
if (options.dsn) {
  Sentry.init({
    ...options,
    // Client bundles only see NEXT_PUBLIC_ vars, so these two come from the build.
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "development",
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || undefined,
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
