import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  // react-pdf ships its own fontkit/yoga; keep it out of the bundle and ship the fonts with the lambdas.
  serverExternalPackages: ["@react-pdf/renderer"],
  outputFileTracingIncludes: {
    // pdfkit loads its standard-font metrics (Helvetica = default font) via a dynamic require that is not traced.
    "/api/trips/[id]/pdf": ["./src/assets/fonts/**", "./node_modules/pdfkit/js/standard-fonts/**"],
    "/api/share/[token]/pdf": ["./src/assets/fonts/**", "./node_modules/pdfkit/js/standard-fonts/**"],
  },
  // Make the Vercel build info visible to the browser bundle (Sentry environment/release).
  env: {
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV ?? "development",
    NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? "",
  },
};

// Sentry docs checked 2026-10-28:
//   https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/
//   https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/build/
// Source maps are uploaded only when SENTRY_AUTH_TOKEN is set (Vercel build env);
// otherwise the build stays quiet and uploads nothing. Client maps are deleted
// after upload, and maps are never referenced from the served JS.
// No tunnelRoute: see docs/runbook.md ("Sentry", ad blockers).
const hasAuthToken = Boolean(process.env.SENTRY_AUTH_TOKEN);

export default withSentryConfig(withNextIntl(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  telemetry: false,
  sourcemaps: {
    disable: !hasAuthToken,
    deleteSourcemapsAfterUpload: true,
  },
});
