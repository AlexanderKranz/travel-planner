"use client";

import { useId, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { btnSecondary, inputCls, mutedCls } from "@/components/ui/styles";
import type { ActionError } from "@/lib/domain";
import { SHARE_ACCESS, type Grant, type ShareAccess, type ShareResource } from "@/lib/domain/sharing";
import { setShareAccess, unshare } from "@/lib/server/sharing";
import { personLabel } from "./helpers";

/** One person with access: name (email below), access select, remove with confirmation. */
export function GrantRow({
  resource,
  grant,
  onChanged,
  onError,
}: {
  resource: ShareResource;
  grant: Grant;
  /** Called after a successful change; the parent announces `kind` and refreshes. */
  onChanged: (kind: "accessChanged" | "removed") => void;
  onError: (error: ActionError) => void;
}) {
  const t = useTranslations("sharing");
  const selectId = useId();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [access, setAccess] = useState<ShareAccess>(grant.access);
  const name = personLabel(grant.grantee);

  function change(next: ShareAccess) {
    const before = access;
    setAccess(next);
    start(async () => {
      const r = await setShareAccess({ resource, shareId: grant.id, access: next });
      if (r.ok) onChanged("accessChanged");
      else {
        setAccess(before);
        onError(r.error);
      }
    });
  }

  function remove() {
    start(async () => {
      const r = await unshare({ resource, shareId: grant.id });
      setOpen(false);
      if (r.ok) onChanged("removed");
      else onError(r.error);
    });
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-[14px] border border-line bg-card p-3">
      <div className="min-w-0 flex-1 basis-full text-sm sm:basis-48">
        <p className="truncate font-medium" title={name}>
          {name}
        </p>
        {grant.grantee.name && (
          <p className={`truncate text-xs ${mutedCls}`} title={grant.grantee.email}>
            {grant.grantee.email}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 sm:flex-none">
        <label htmlFor={selectId} className="sr-only">
          {t("changeAccess", { name })}
        </label>
        <select
          id={selectId}
          value={access}
          disabled={pending}
          onChange={(e) => change(e.target.value as ShareAccess)}
          className={`${inputCls} min-w-0 flex-1 sm:w-auto sm:flex-none`}
        >
          {SHARE_ACCESS.map((a) => (
            <option key={a} value={a}>
              {t(`access.${a}`)}
            </option>
          ))}
        </select>
        <button type="button" className={btnSecondary} disabled={pending} onClick={() => setOpen(true)} aria-label={t("removeFor", { name })}>
          {t("remove")}
        </button>
      </div>
      {open && (
        <ConfirmDialog
          open
          title={t("removeFor", { name })}
          description={t("confirmRemove", { name })}
          confirmLabel={t("remove")}
          cancelLabel={t("cancel")}
          pending={pending}
          onConfirm={remove}
          onCancel={() => setOpen(false)}
        />
      )}
    </li>
  );
}
