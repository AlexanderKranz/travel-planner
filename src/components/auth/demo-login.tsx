"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { ErrorBanner } from "@/components/ui/error-banner";
import { btnSecondary, mutedCls } from "@/components/ui/styles";
import { signInDemo } from "@/lib/server/auth/actions";
import type { ActionError } from "@/lib/domain";

export function DemoLogin() {
  const t = useTranslations("login.demo");
  const locale = useLocale();
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const result = await signInDemo(locale);
      if (result && !result.ok) setError(result.error);
    });
  }

  return (
    <section
      aria-labelledby="demo-title"
      className="flex flex-col gap-3 border-t border-neutral-300 pt-6 dark:border-neutral-700"
    >
      <h2 id="demo-title" className="text-lg font-semibold">
        {t("heading")}
      </h2>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <ErrorBanner error={error} />
        <button type="submit" className={btnSecondary} disabled={pending}>
          {t("button")}
        </button>
        <p className={`text-sm ${mutedCls}`}>{t("hint")}</p>
      </form>
    </section>
  );
}
