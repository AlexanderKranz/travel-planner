"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { SelectField, TextField } from "@/components/ui/fields";
import { btnSecondary, mutedCls } from "@/components/ui/styles";
import { ROUTE_OPTIONS_BY_MODE, TOUR_MODES, type RouteOption, type TourSuggestion } from "@/lib/domain/tour";
import { choicesWith, DURATION_CHOICES, DWELL_DEFAULT_CHOICES, withMode, type EndKind, type FormPoint, type TourForm } from "@/lib/tour/ui";
import { formatDuration } from "./format";
import { ModeIcon } from "./mode-icon";
import { PlaceSearch } from "./place-search";

const segment =
  "flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md border border-line-strong px-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent has-[:checked]:text-white has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus";

const toPoint = (s: TourSuggestion): FormPoint => ({ key: s.key, ref: s.ref, name: s.name, lat: s.lat, lon: s.lon, source: s.source, ...(s.cat ? { cat: s.cat } : {}) });

function PointPicker({
  label,
  searchLabel,
  value,
  centre,
  isTaken,
  onChange,
}: {
  label: string;
  searchLabel: string;
  value: FormPoint | null;
  centre: { lat: number; lon: number } | null;
  isTaken: (key: string) => boolean;
  onChange: (p: FormPoint | null) => void;
}) {
  const t = useTranslations("tours");
  if (value) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{label}</p>
        <div className="flex items-center justify-between gap-2 rounded-md border border-line p-2 pl-3">
          <strong className="min-w-0 break-words">{value.name}</strong>
          <button type="button" className={btnSecondary} onClick={() => onChange(null)}>
            {t("pointChange")}
          </button>
        </div>
      </div>
    );
  }
  return <PlaceSearch label={searchLabel} centre={centre} isTaken={isTaken} use="endpoint" onPick={(s) => onChange(toPoint(s))} />;
}

type Props = {
  form: TourForm;
  centre: { lat: number; lon: number } | null;
  isTaken: (key: string) => boolean;
  onChange: (f: TourForm) => void;
};

/** "Mehr Optionen" (spec 2.1): collapsed by default; every field optional. */
export function TourOptions({ form, centre, isTaken, onChange }: Props) {
  const t = useTranslations("tours");
  const id = useId();
  const set = <K extends keyof TourForm>(k: K, v: TourForm[K]) => onChange({ ...form, [k]: v });
  const durationSelect = (key: "minMin" | "maxMin", label: string) => (
    <SelectField label={label} value={form[key]} onChange={(e) => set(key, e.target.value)}>
      <option value="">{t("durationNone")}</option>
      {choicesWith(DURATION_CHOICES, form[key] ? Number(form[key]) : undefined).map((m) => (
        <option key={m} value={m}>
          {formatDuration(t, m)}
        </option>
      ))}
    </SelectField>
  );

  return (
    <details className="rounded-[14px] border border-line bg-card" data-testid="tour-options">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 font-semibold">{t("moreOptions")}</summary>
      <div className="flex flex-col gap-5 px-4 pb-4">
        <PointPicker
          label={t("start")}
          searchLabel={t("startSearch")}
          value={form.start}
          centre={centre}
          isTaken={isTaken}
          onChange={(p) => onChange({ ...form, start: p, endKind: !p && form.endKind === "start" ? "none" : form.endKind })}
        />
        {!form.start && <p className={`-mt-4 text-sm ${mutedCls}`}>{t("startNone")}</p>}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t("end")}</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {(["none", "start", "other"] as EndKind[]).map((k) => (
              <label key={k} className={`${segment} ${k === "start" && !form.start ? "pointer-events-none opacity-50" : ""}`}>
                <input
                  type="radio"
                  name={`${id}-end`}
                  className="sr-only"
                  disabled={k === "start" && !form.start}
                  checked={form.endKind === k}
                  onChange={() => onChange({ ...form, endKind: k, end: k === "other" ? form.end : null })}
                />
                {t(k === "none" ? "endNone" : k === "start" ? "endSame" : "endOther")}
              </label>
            ))}
          </div>
          {form.endKind === "other" && (
            <PointPicker label={t("end")} searchLabel={t("endSearch")} value={form.end} centre={centre} isTaken={isTaken} onChange={(p) => set("end", p)} />
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">{t("mode")}</legend>
          <div className="grid grid-cols-2 gap-2">
            {TOUR_MODES.map((m) => (
              <label key={m} className={segment}>
                <input type="radio" name={`${id}-mode`} className="sr-only" checked={form.mode === m} onChange={() => onChange(withMode(form, m))} />
                <ModeIcon mode={m} />
                {t(`modes.${m}`)}
              </label>
            ))}
          </div>
        </fieldset>

        <SelectField label={t("route")} hint={t(`routeHelp.${form.route}`)} value={form.route} onChange={(e) => set("route", e.target.value as RouteOption)}>
          {ROUTE_OPTIONS_BY_MODE[form.mode].map((r) => (
            <option key={r} value={r}>
              {t(`routes.${r}`)}
            </option>
          ))}
        </SelectField>

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">{t("orderLabel")}</legend>
          <div className="grid grid-cols-2 gap-2">
            {(["optimize", "keep"] as const).map((o) => (
              <label key={o} className={segment}>
                <input type="radio" name={`${id}-order`} className="sr-only" checked={form.order === o} onChange={() => set("order", o)} />
                {t(`order.${o}`)}
              </label>
            ))}
          </div>
          <p className={`text-sm ${mutedCls}`}>{t("orderHelp")}</p>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          <TextField label={t("date")} type="date" value={form.date} onChange={(e) => set("date", e.target.value)} />
          <TextField label={t("startTime")} type="time" value={form.startTime} onChange={(e) => set("startTime", e.target.value)} />
          <TextField
            label={t("endBy")}
            type="time"
            hint={form.startTime ? undefined : t("endByHint")}
            disabled={!form.startTime}
            value={form.endBy}
            onChange={(e) => set("endBy", e.target.value)}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          {durationSelect("minMin", t("minDuration"))}
          {durationSelect("maxMin", t("maxDuration"))}
          <SelectField
            label={t("dwellDefault")}
            hint={t("dwellEstimate")}
            value={String(form.dwellDefaultMin)}
            onChange={(e) => set("dwellDefaultMin", Number(e.target.value))}
          >
            {choicesWith(DWELL_DEFAULT_CHOICES, form.dwellDefaultMin).map((m) => (
              <option key={m} value={m}>
                {formatDuration(t, m)}
              </option>
            ))}
          </SelectField>
        </div>

        <TextField label={t("titleLabel")} hint={t("titleHint")} maxLength={120} value={form.title} onChange={(e) => set("title", e.target.value)} />
      </div>
    </details>
  );
}
