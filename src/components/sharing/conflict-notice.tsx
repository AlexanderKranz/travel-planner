"use client";

import { useTranslations } from "next-intl";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";

/**
 * Shown when a save found that someone else saved first. The user's draft is kept; they choose between taking the
 * latest version (their edits are dropped) and saving their draft over it on purpose.
 */
export function ConflictNotice({
  onLoadLatest,
  onOverwrite,
  pending,
}: {
  onLoadLatest: () => void;
  /** Absent when the latest version could not be read: then only loading is offered. */
  onOverwrite?: () => void;
  pending: boolean;
}) {
  const t = useTranslations("sharing");
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-lg border border-warn-line bg-warn-bg p-3 text-sm text-warn-fg">
      <p>{t("conflictForm")}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" className={btnSecondary} disabled={pending} onClick={onLoadLatest}>
          {t("conflictLoad")}
        </button>
        {onOverwrite && (
          <button type="button" className={btnPrimary} disabled={pending} onClick={onOverwrite}>
            {t("conflictOverwrite")}
          </button>
        )}
      </div>
    </div>
  );
}
