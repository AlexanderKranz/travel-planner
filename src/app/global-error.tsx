"use client";

// Last-resort error boundary (replaces the root layout, so it cannot use
// next-intl). Keep the text neutral and bilingual; it is not routed through
// messages/*.json because the i18n provider is not available here.
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <h1>Something went wrong / Etwas ist schiefgelaufen</h1>
        <p>Please reload the page. / Bitte lade die Seite neu.</p>
      </body>
    </html>
  );
}
