"use client";

import * as Sentry from "@sentry/nextjs";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { btnPrimary, linkCls, mutedCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";

/**
 * Body of every `error.tsx` boundary. Friendly text only: the raw error message is never shown (in production
 * Next hides server errors anyway, but client errors would leak). The digest is shown as an opaque reference
 * so a user can quote it. The error is reported to Sentry here because the Sentry SDK does not see errors that a
 * boundary has already caught (server render errors are also reported by `onRequestError` with the same digest).
 */
export function ErrorView({
  error,
  reset,
  homeHref,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  homeHref: "/" | "/app";
}) {
  const t = useTranslations("errorPage");
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-12">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
      <p className={mutedCls}>{t("text")}</p>
      <div role="group" aria-label={t("actions")} className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={reset} className={btnPrimary}>
          {t("retry")}
        </button>
        <Link href={homeHref} className={`${linkCls} inline-flex min-h-11 items-center`}>
          {homeHref === "/app" ? t("toApp") : t("toHome")}
        </Link>
      </div>
      {error.digest && (
        <p className={`${mutedCls} text-xs`}>
          {t("reference")}: <code>{error.digest}</code>
        </p>
      )}
    </main>
  );
}
