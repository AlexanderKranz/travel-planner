"use client";

import { useHydrated } from "@/lib/hooks/use-hydrated";

/**
 * Rendered on the server, removed once React hydrates. CSS shows it only after a few seconds (`.load-notice` in
 * globals.css), so a normal load never flashes it; it stays when the app scripts failed to load. With JavaScript off the
 * `<noscript>` style shows it at once. Browsers that cannot animate `display` never show it (same as before).
 */
export function LoadNotice({ text }: { text: string }) {
  const hydrated = useHydrated();
  if (hydrated) return null;
  return (
    <>
      <noscript>
        <style>{".load-notice{display:block;animation:none}"}</style>
      </noscript>
      <p role="status" className="load-notice rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg">
        {text}
      </p>
    </>
  );
}
