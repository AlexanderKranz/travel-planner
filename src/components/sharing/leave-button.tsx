"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorBanner } from "@/components/ui/error-banner";
import { btnSecondary } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import type { ShareResource } from "@/lib/domain/sharing";
import { leaveShare } from "@/lib/server/sharing";

/** Recipient: give the access back. Confirms, then goes to the trips list. */
export function LeaveButton({ resource, shareId, ownerName }: { resource: ShareResource; shareId: string; ownerName: string }) {
  const t = useTranslations("sharing");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, start] = useTransition();

  function leave() {
    start(async () => {
      const r = await leaveShare({ resource, shareId });
      if (r.ok) {
        router.push(resource === "trip" ? "/app" : resource === "group" ? "/app/groups" : "/app/purposes");
        router.refresh();
      } else {
        setOpen(false);
        setError(r.error);
      }
    });
  }

  return (
    <>
      <button type="button" className={btnSecondary} onClick={() => setOpen(true)} data-no-print>
        {t("leave")}
      </button>
      <ErrorBanner error={error} />
      {open && (
        <ConfirmDialog
          open
          title={t("leaveTitle")}
          description={t(resource === "group" ? "confirmLeaveGroup" : "confirmLeave", { name: ownerName })}
          confirmLabel={t("leave")}
          cancelLabel={t("cancel")}
          pending={pending}
          onConfirm={leave}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}
