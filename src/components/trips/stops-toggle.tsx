"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { CheckboxField } from "@/components/ui/fields";
import { btnPrimary, btnSecondary } from "@/components/ui/styles";

/** "Mehrere Stationen" ([D1]): UI state only. Unticking with stops in the list asks before clearing them. */
export function StopsToggle({
  checked,
  hasStops,
  onChange,
  onClear,
}: {
  checked: boolean;
  hasStops: boolean;
  onChange: (checked: boolean) => void;
  /** Unticks and empties the list. */
  onClear: () => void;
}) {
  const t = useTranslations("trips.stops");
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <CheckboxField
        label={t("multiStop")}
        checked={checked}
        onChange={(e) => (e.target.checked || !hasStops ? onChange(e.target.checked) : setConfirm(true))}
      />
      {confirm && (
        <div role="alertdialog" aria-label={t("clearConfirm")} className="flex flex-col gap-2 rounded-lg border border-danger-line p-3">
          <p className="text-sm font-medium">{t("clearConfirm")}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              className={btnPrimary}
              onClick={() => {
                setConfirm(false);
                onClear();
              }}
            >
              {t("clearYes")}
            </button>
            <button type="button" className={btnSecondary} onClick={() => setConfirm(false)}>
              {t("clearNo")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
