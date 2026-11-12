"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef } from "react";
import { SelectField } from "@/components/ui/fields";
import { btnPrimary, btnSecondary, mutedCls } from "@/components/ui/styles";
import { ROUTE_OPTIONS_BY_MODE, TOUR_MODES, type RouteOption } from "@/lib/domain/tour";
import { sheetMode, type LegSheet as SheetState } from "@/lib/tour/ui";
import { ModeIcon } from "./mode-icon";

type Props = {
  sheet: SheetState | null;
  fromName: string;
  toName: string;
  onChange: (s: SheetState) => void;
  onApply: () => void;
  onReset: () => void;
  onClose: () => void;
};

/**
 * "Ändern" on a leg (spec 2.1 step 3): mode and route option for this leg only, as a bottom sheet on phones and a
 * centred dialog from `sm` on. Native <dialog>: focus trap and Escape for free.
 */
export function LegSheet({ sheet, fromName, toName, onChange, onApply, onReset, onClose }: Props) {
  const t = useTranslations("tours");
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const name = useId();
  const open = sheet !== null;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[90dvh] w-full max-w-none overflow-y-auto rounded-t-[14px] border border-line-strong bg-card p-5 text-ink backdrop:bg-black/50 sm:inset-0 sm:m-auto sm:h-fit sm:max-w-md sm:rounded-[14px]"
    >
      {sheet && (
        <div className="flex flex-col gap-4">
          <h2 id={titleId} className="break-words text-lg font-semibold">
            {t("legSheetTitle", { from: fromName, to: toName })}
          </h2>
          <p className={`text-sm ${mutedCls}`}>{t("legSheetHint")}</p>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium">{t("mode")}</legend>
            <div className="grid grid-cols-2 gap-2">
              {TOUR_MODES.map((m) => (
                <label
                  key={m}
                  className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md border border-line-strong px-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent has-[:checked]:text-white has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus"
                >
                  <input type="radio" name={name} className="sr-only" checked={sheet.mode === m} onChange={() => onChange(sheetMode(sheet, m))} />
                  <ModeIcon mode={m} />
                  {t(`modes.${m}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <SelectField
            label={t("route")}
            hint={t(`routeHelp.${sheet.route}`)}
            value={sheet.route}
            onChange={(e) => onChange({ ...sheet, route: e.target.value as RouteOption })}
          >
            {ROUTE_OPTIONS_BY_MODE[sheet.mode].map((r) => (
              <option key={r} value={r}>
                {t(`routes.${r}`)}
              </option>
            ))}
          </SelectField>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button type="button" className={btnSecondary} onClick={onClose}>
              {t("cancel")}
            </button>
            <button type="button" className={btnSecondary} onClick={onReset}>
              {t("legReset")}
            </button>
            <button type="button" className={btnPrimary} onClick={onApply}>
              {t("legApply")}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
