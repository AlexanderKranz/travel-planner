"use client";

import { ErrorView } from "@/components/app/error-view";

/** Boundary for the public pages (start, login, settings, sources, shared plans). */
export default function LocaleError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView {...props} homeHref="/" />;
}
