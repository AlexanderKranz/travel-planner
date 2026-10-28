"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { focusCls } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import { ITEM_STATUSES, type ItemStatus } from "@/lib/domain/items";
import { setItemStatus } from "@/lib/server/items";
import { ItemError } from "./item-error";
import { statusTone } from "./status-badge";

/** Radio group of the four statuses; optimistic, reverts and announces on error. */
export function StatusControl({ id, title, status }: { id: string; title: string; status: ItemStatus }) {
  const t = useTranslations("items");
  const router = useRouter();
  const [current, setCurrent] = useState(status);
  const [shown, setShown] = useState(status);
  const [error, setError] = useState<ActionError | null>(null);
  const [, start] = useTransition();
  // Follow the server value after a refresh.
  if (status !== shown) {
    setShown(status);
    setCurrent(status);
  }

  function choose(next: ItemStatus) {
    if (next === current) return;
    const prev = current;
    setCurrent(next);
    setError(null);
    start(async () => {
      const r = await setItemStatus(id, next);
      if (r.ok) router.refresh();
      else {
        setCurrent(prev);
        setError(r.error);
      }
    });
  }

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto">
      <div role="radiogroup" aria-label={t("statusGroup", { title })} className="grid grid-cols-2 gap-1.5 sm:flex">
        {ITEM_STATUSES.map((s) => {
          const on = s === current;
          return (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => choose(s)}
              className={`inline-flex min-h-11 items-center justify-center rounded-full border px-3 text-sm ${focusCls} ${
                on ? `font-semibold ${statusTone[s]}` : "border-neutral-300 hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
              }`}
            >
              {t(`statuses.${s}`)}
            </button>
          );
        })}
      </div>
      <div aria-live="polite">
        <ItemError error={error} />
      </div>
    </div>
  );
}
