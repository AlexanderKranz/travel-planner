"use client";

import { ErrorView } from "@/components/app/error-view";

/** Boundary inside the signed-in shell: the header and navigation stay, only the page body is replaced. */
export default function AppError(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorView {...props} homeHref="/app" />;
}
