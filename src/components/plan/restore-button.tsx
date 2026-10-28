"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { linkCls } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import { restorePlanVersion } from "@/lib/server/plans";
import { asPlanError } from "./helpers";
import { PlanErrorBanner } from "./plan-runner";

export function RestoreButton({ tripId, versionNo, disabled }: { tripId: string; versionNo: number; disabled?: boolean }) {
  const t = useTranslations("plan.versions");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, start] = useTransition();

  function confirm() {
    start(async () => {
      const r = await restorePlanVersion(tripId, versionNo);
      if (r.ok) {
        setOpen(false);
        // Back to the latest version, which is now the restored copy.
        router.push(`/app/trips/${tripId}`, { scroll: false });
        router.refresh();
      } else {
        setOpen(false);
        setError(asPlanError(r.error));
      }
    });
  }

  return (
    <>
      <button
        type="button"
        className={`${linkCls} inline-flex min-h-11 items-center disabled:opacity-50`}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {t("restore")}
        <span className="sr-only"> v{versionNo}</span>
      </button>
      {open && (
        <ConfirmDialog
          open
          title={t("restoreTitle", { n: versionNo })}
          description={t("restoreBody", { n: versionNo })}
          confirmLabel={t("restoreConfirm")}
          cancelLabel={t("cancel")}
          pending={pending}
          onConfirm={confirm}
          onCancel={() => setOpen(false)}
        />
      )}
      <PlanErrorBanner error={error} />
    </>
  );
}
