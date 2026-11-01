"use client";

import { useLinkStatus } from "next/link";
import { useTranslations } from "next-intl";

/**
 * Pending indicator rendered inside a <Link>. `useLinkStatus` turns true the moment the link is clicked and stays
 * true until the next page has rendered, so the card reacts instantly while the trip page loads its data.
 * The live region is always mounted so screen readers announce the text when it appears.
 */
export function TripCardPending() {
  const { pending } = useLinkStatus();
  const t = useTranslations("trips");
  return (
    <span role="status" aria-live="polite" data-pending={pending ? "true" : undefined}>
      {pending && (
        <>
          <span
            aria-hidden="true"
            className="absolute right-3 top-3 inline-block size-5 animate-spin rounded-full border-2 border-line-strong border-t-transparent motion-reduce:animate-none"
          />
          <span className="sr-only">{t("opening")}</span>
        </>
      )}
    </span>
  );
}
