"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useId } from "react";
import { inputCls } from "@/components/ui/styles";
import { MAX_TRIP_DAYS } from "@/lib/domain/common";
import { btnSecondary, errorCls, mutedCls } from "@/components/ui/styles";
import { FLAG_KEY, rowDate, rowFlags, rowProblems, type StopRow } from "./stops-draft";

const labelCls = "text-xs font-medium";

/** One stop. At 360 px a stacked card (day, place, times side by side, toggle + remove); from `sm` one grid row. */
export function StopRowEditor({
  row,
  index,
  startDate,
  lengthDays,
  showProblems,
  onChange,
  onRemove,
}: {
  row: StopRow;
  index: number;
  startDate: string | null;
  lengthDays: number;
  /** Mark a missing place or day (after a failed save). */
  showProblems: boolean;
  onChange: (patch: Partial<StopRow>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("trips.stops");
  const f = useFormatter();
  const uid = useId();
  const n = index + 1;
  const flags = rowFlags(row, { startDate, lengthDays }).flatMap((k) => (FLAG_KEY[k] ? [FLAG_KEY[k]] : []));
  const problems = showProblems ? rowProblems(row, lengthDays) : [];
  const dayCount = Math.min(MAX_TRIP_DAYS, Math.max(Number.isFinite(lengthDays) ? lengthDays : 1, row.day));
  const dateLabel = (day: number) => {
    const d = rowDate(startDate, day);
    return d ? f.dateTime(new Date(`${d}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }) : null;
  };
  const warnId = `${uid}-warn`;

  return (
    <li
      aria-labelledby={`${uid}-title`}
      className="grid min-w-0 gap-3 rounded-[14px] border border-line bg-card p-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_7.5rem_7.5rem] sm:items-end"
    >
      <p id={`${uid}-title`} className="sr-only">
        {t("stopN", { n })}
      </p>

      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${uid}-day`} className={labelCls}>
          {t("day")}
        </label>
        <select
          id={`${uid}-day`}
          className={inputCls}
          value={row.day}
          aria-invalid={problems.includes("day") ? true : undefined}
          aria-describedby={flags.length ? warnId : undefined}
          onChange={(e) => onChange({ day: Number(e.target.value), date: undefined })}
        >
          {Array.from({ length: dayCount }, (_, i) => i + 1).map((d) => {
            const date = dateLabel(d);
            return (
              <option key={d} value={d}>
                {date ? t("dayOption", { n: d, date }) : t("dayOptionNoDate", { n: d })}
              </option>
            );
          })}
        </select>
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={`${uid}-place`} className={labelCls}>
          {t("place")}
        </label>
        <input
          id={`${uid}-place`}
          type="text"
          maxLength={80}
          className={inputCls}
          value={row.place}
          disabled={row.sea}
          aria-invalid={problems.includes("place") ? true : undefined}
          onChange={(e) => onChange({ place: e.target.value, flags: row.flags.filter((x) => x !== "from_image") })}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:contents">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${uid}-arr`} className={labelCls}>
            {t("arrive")}
          </label>
          <input id={`${uid}-arr`} type="time" className={inputCls} value={row.arr} onChange={(e) => onChange({ arr: e.target.value })} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${uid}-dep`} className={labelCls}>
            {t("depart")}
          </label>
          <input id={`${uid}-dep`} type="time" className={inputCls} value={row.dep} onChange={(e) => onChange({ dep: e.target.value })} />
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
        <label htmlFor={`${uid}-note`} className={labelCls}>
          {t("note")}
        </label>
        <input id={`${uid}-note`} type="text" maxLength={60} className={inputCls} value={row.note} onChange={(e) => onChange({ note: e.target.value })} />
      </div>

      <div className="flex items-center justify-between gap-3 sm:col-span-2 sm:justify-end">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5 accent-accent"
            checked={row.sea}
            onChange={(e) => onChange({ sea: e.target.checked })}
          />
          {t("sea")}
        </label>
        <button type="button" className={btnSecondary} aria-label={t("remove", { n })} onClick={onRemove}>
          <span aria-hidden="true">×</span>
        </button>
      </div>

      {(flags.length > 0 || problems.length > 0) && (
        <ul id={warnId} className="flex flex-col gap-0.5 text-sm sm:col-span-4">
          {problems.length > 0 && <li className={errorCls}>{t("invalidRow")}</li>}
          {flags.map((k) => (
            <li key={k} className={`${k === "outsideTrip" ? errorCls : mutedCls}`}>
              <span aria-hidden="true">⚠ </span>
              {t(`flag.${k}` as "flag.outsideTrip")}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
