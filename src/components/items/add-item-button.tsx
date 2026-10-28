"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { btnPrimary, focusCls, linkCls } from "@/components/ui/styles";
import type { ItemFormCtx, Prefill } from "./helpers";
import { ItemForm } from "./item-form";

/** "Add cost item" button (primary), a compact "+ Add cost item" link (flights) or an icon-only "+" (day rows). */
export function AddItemButton({
  ctx,
  prefill,
  quickLabel,
  icon = false,
  className = "",
}: {
  ctx: ItemFormCtx;
  prefill?: Prefill;
  /** Set for quick add: accessible name context, e.g. the place name. */
  quickLabel?: string;
  /** Quick add as an icon-only "+" (tight spots); the full text is its aria-label and tooltip. */
  icon?: boolean;
  className?: string;
}) {
  const t = useTranslations("items");
  const [open, setOpen] = useState(false);
  return (
    <>
      {quickLabel && icon ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t("quickAddFor", { title: quickLabel })}
          title={t("quickAdd")}
          className={`${focusCls} inline-flex size-11 items-center justify-center rounded-md text-lg leading-none text-accent-text hover:bg-hover ${className}`}
        >
          <span aria-hidden="true">+</span>
        </button>
      ) : quickLabel ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t("quickAddFor", { title: quickLabel })}
          className={`${linkCls} ${focusCls} inline-flex min-h-11 items-center whitespace-nowrap px-1 text-sm ${className}`}
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
