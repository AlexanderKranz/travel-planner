"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { btnSecondary } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import type { TripItem } from "@/lib/domain/items";
import { deleteItem } from "@/lib/server/items";
import { ItemError } from "./item-error";
import { ItemForm } from "./item-form";
import type { ItemFormCtx } from "./helpers";

/** Edit and delete for one item (owner only). */
export function ItemActions({
  item,
  tripId,
  lengthDays,
  partySize,
  startDate,
  flights,
}: ItemFormCtx & { item: TripItem }) {
  const t = useTranslations("items");
  const router = useRouter();
  const [edit, setEdit] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, start] = useTransition();

  function remove() {
    start(async () => {
      const r = await deleteItem(item.id);
      setConfirm(false);
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  }

  return (
    <>
      <button type="button" className={btnSecondary} onClick={() => setEdit(true)} aria-label={t("editFor", { title: item.title })}>
        {t("edit")}
      </button>
      <button type="button" className={btnSecondary} onClick={() => setConfirm(true)} aria-label={t("deleteFor", { title: item.title })}>
        {t("delete")}
      </button>
      <div aria-live="polite" className="w-full empty:hidden">
        <ItemError error={error} />
      </div>
      {edit && <ItemForm tripId={tripId} lengthDays={lengthDays} partySize={partySize} startDate={startDate} flights={flights} item={item} onClose={() => setEdit(false)} />}
      {confirm && (
        <ConfirmDialog
          open
          title={t("delete")}
          description={t("confirmDelete", { title: item.title })}
          confirmLabel={t("delete")}
          cancelLabel={t("cancel")}
          pending={pending}
          onConfirm={remove}
          onCancel={() => setConfirm(false)}
        />
      )}
    </>
  );
}
