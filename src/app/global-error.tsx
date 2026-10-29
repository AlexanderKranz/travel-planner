"use client";

// Last-resort error boundary (replaces the root layout, so it cannot use
// next-intl). Keep the text neutral and bilingual; it is not routed through
// messages/*.json because the i18n provider is not available here.
// Colours mirror the Atlas light tokens (no stylesheet is guaranteed here).
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset?: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", background: "#f6f1e7", color: "#1c2430" }}>
        <main style={{ maxWidth: "36rem", margin: "0 auto" }}>
          <h1 style={{ color: "#1f3a5f" }}>
            Something went wrong / <span lang="de">Etwas ist schiefgelaufen</span>
          </h1>
          <p>
            Please try again. / <span lang="de">Bitte versuche es noch einmal.</span>
          </p>
          <button
            type="button"
            onClick={() => (reset ? reset() : window.location.reload())}
            style={{
              minHeight: "44px",
              padding: "0.5rem 1.25rem",
              border: 0,
              borderRadius: "8px",
              background: "#a84c24",
              color: "#ffffff",
              fontSize: "1rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Retry / <span lang="de">Erneut versuchen</span>
          </button>
          {error.digest && (
            <p style={{ fontSize: "0.8rem", color: "#4a5562" }}>
              Ref / <span lang="de">Referenz</span>: <code>{error.digest}</code>
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
