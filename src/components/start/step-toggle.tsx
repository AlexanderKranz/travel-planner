"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { btnSecondary, mutedCls } from "@/components/ui/styles";

/**
 * Collapsible step body. "Later" folds the form away (skips the step for now) without saving anything.
 * `closedLabel` / `closedNote` describe the collapsed state (skipped, or already done).
 */
export function StepToggle({
  defaultOpen,
  closedLabel,
  closedNote,
  children,
}: {
  defaultOpen: boolean;
  closedLabel: string;
  closedNote: string;
  children: React.ReactNode;
}) {
  const t = useTranslations("start");
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="flex flex-col gap-3">
      <div id={id} hidden={!open} className="flex flex-col gap-4">
        {children}
      </div>
      {!open && <p className={`text-sm ${mutedCls}`}>{closedNote}</p>}
      <div>
        <button
          type="button"
          className={btnSecondary}
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? t("later") : closedLabel}
        </button>
      </div>
    </div>
  );
}
