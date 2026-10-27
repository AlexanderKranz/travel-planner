import * as Sentry from "@sentry/nextjs";
import { buildSentryOptions } from "@/lib/sentry-options";

const options = buildSentryOptions();
if (options.dsn) Sentry.init(options);
