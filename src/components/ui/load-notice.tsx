"use client";

import { useHydrated } from "@/lib/hooks/use-hydrated";

/**
 * Rendered on the server, removed once React hydrates. Hidden by CSS (`.load-notice` in globals.css) until the inline
 * timer in `NoscriptNotice` shows it (scripts failed to load), or at once via the `<noscript>` style (JavaScript off).
 */
export function LoadNotice({ text }: { text: string }) {
  const hydrated = useHydrated();
  if (hydrated) return null;
  return (
    <>
      <noscript>
        <style>{".load-notice{display:block}"}</style>
      </noscript>
      <p role="alert" className="load-notice rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg">
        {text}
      </p>
    </>
  );
}
