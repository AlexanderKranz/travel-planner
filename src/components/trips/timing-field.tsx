"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";
import { errorCls, inputCls, mutedCls } from "@/components/ui/styles";
import type { TimingDraft } from "./trip-draft";
import { monthName } from "./trip-title";

const chip =
  "flex min-h-11 cursor-pointer items-center justify-center rounded-md border border-neutral-400 px-3 text-sm select-none dark:border-neutral-500 has-[:checked]:border-blue-700 has-[:checked]:bg-blue-700 has-[:checked]:text-white dark:has-[:checked]:border-blue-400 dark:has-[:checked]:bg-blue-400 dark:has-[:checked]:text-neutral-950 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-blue-600";

export function TimingField({
  value,
  onChange,
  error,
}: {
  value: TimingDraft;
  onChange: (v: TimingDraft) => void;
  error?: string;
}) {
  const t = useTranslations("trips.form.timing");
  const locale = useLocale();
  const id = useId();
  const modes = [
    ["none", t("none")],
    ["date", t("date")],
    ["months", t("months")],
  ] as const;

  function toggleMonth(m: number) {
    const months = value.months.includes(m)
      ? value.months.filter((x) => x !== m)
      : [...value.months, m].sort((a, b) => a - b);
    onChange({ ...value, months });
  }

  return (
    <fieldset className="flex flex-col gap-3" aria-describedby={error ? `${id}-err` : undefined}>
      <legend className="mb-1 text-sm font-medium">{t("legend")}</legend>
      <div className="grid grid-cols-3 gap-2">
        {modes.map(([mode, label]) => (
          <label key={mode} className={chip}>
            <input
              type="radio"
              name={`${id}-mode`}
              className="sr-only"
              checked={value.mode === mode}
              onChange={() => onChange({ ...value, mode })}
            />
            {label}
          </label>
        ))}
      </div>
      {value.mode === "none" && <p className={`text-sm ${mutedCls}`}>{t("noneHint")}</p>}
      {value.mode === "date" && (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-date`} className="text-sm font-medium">
            {t("startDate")}
          </label>
          <input
            id={`${id}-date`}
            type="date"
            required
            min="2000-01-01"
            max="2100-12-31"
            value={value.startDate}
            onChange={(e) => onChange({ ...value, startDate: e.target.value })}
            className={inputCls}
          />
        </div>
      )}
      {value.mode === "months" && (
        <div className="flex flex-col gap-2">
          <p className={`text-sm ${mutedCls}`}>{t("monthsHint")}</p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" role="group" aria-label={t("monthsLabel")}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <label key={m} className={chip}>
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={value.months.includes(m)}
                  onChange={() => toggleMonth(m)}
                />
                {monthName(m, locale)}
              </label>
            ))}
          </div>
        </div>
      )}
      {error && (
        <p id={`${id}-err`} className={errorCls}>
          {error}
        </p>
      )}
    </fieldset>
  );
}
