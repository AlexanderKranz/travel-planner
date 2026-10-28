"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { btnPrimary, focusCls, linkCls } from "@/components/ui/styles";
import type { Prefill } from "./helpers";
import { ItemForm } from "./item-form";

type Ctx = { tripId: string; lengthDays: number; partySize: number | null };

/** "Add item" button (primary) or a compact "+ item" link (quick add from a place or flight). */
export function AddItemButton({
  ctx,
  prefill,
  quickLabel,
}: {
  ctx: Ctx;
  prefill?: Prefill;
  /** Set for quick add: accessible name context, e.g. the place name. */
  quickLabel?: string;
}) {
  const t = useTranslations("items");
  const [open, setOpen] = useState(false);
  return (
    <>
      {quickLabel ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t("quickAddFor", { title: quickLabel })}
          className={`${linkCls} ${focusCls} inline-flex min-h-11 items-center px-1 text-sm`}
        >
          + {t("quickAdd")}
        </button>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className={`${btnPrimary} w-full sm:w-auto`}>
          {t("add")}
        </button>
      )}
      {open && <ItemForm {...ctx} prefill={prefill} onClose={() => setOpen(false)} />}
    </>
  );
}
