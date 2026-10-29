"use client";

import { useState, useTransition } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorBanner } from "@/components/ui/error-banner";
import { btnSecondary, mutedCls } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import type { ShareLink } from "@/lib/domain/share";
import { revokeShareLink } from "@/lib/server/shares";

export function ShareLinkRow({ link, now }: { link: ShareLink; now: number }) {
  const t = useTranslations("share");
  const f = useFormatter();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, start] = useTransition();
  const date = (iso: string) => f.dateTime(new Date(iso), { dateStyle: "medium" });
  const name = link.label ?? t("defaultName", { date: date(link.createdAt) });
  const expired = link.expiresAt !== null && new Date(link.expiresAt).getTime() <= now;

  function revoke() {
    start(async () => {
      const r = await revokeShareLink(link.id);
      setOpen(false);
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[14px] border border-line bg-card p-3">
      <div className="min-w-0 flex-1 basis-56 text-sm">
        <p className="break-words font-medium">{name}</p>
        <p className={mutedCls}>
          {expired ? t("expired") : link.expiresAt ? t("expires", { date: date(link.expiresAt) }) : t("neverExpires")}
          {" · "}
          {link.includeItems ? t("withItems") : t("withoutItems")}
          {" · "}
          {t("views", { count: link.viewCount })}
          {link.lastViewedAt && <>, {t("lastViewed", { date: date(link.lastViewedAt) })}</>}
        </p>
      </div>
      <button type="button" className={btnSecondary} onClick={() => setOpen(true)} aria-label={t("revokeFor", { name })}>
        {t("revoke")}
      </button>
      <div aria-live="polite" className="w-full empty:hidden">
        <ErrorBanner error={error} />
      </div>
      {open && (
        <ConfirmDialog
          open
          title={t("revokeFor", { name })}
          description={t("confirmRevoke")}
          confirmLabel={t("revoke")}
          cancelLabel={t("cancel")}
          pending={pending}
          onConfirm={revoke}
          onCancel={() => setOpen(false)}
        />
      )}
    </li>
  );
}
