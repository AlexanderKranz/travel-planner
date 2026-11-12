"use client";

import { useTranslations } from "next-intl";
import { btnIcon, inputCls, mutedCls } from "@/components/ui/styles";
import { choicesWith, DWELL_CHOICES, moveItem, type FormPoint } from "@/lib/tour/ui";
import { formatDuration } from "./format";

type Props = {
  places: FormPoint[];
  dwellDefaultMin: number;
  /** Keys the last computation flagged as not reachable with the tour mode. */
  unreachable: readonly string[];
  /** Keys the server did not accept (expired reference): search again. */
  unknown: readonly string[];
  onChange: (places: FormPoint[]) => void;
};

const chip = "inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 text-xs";

/**
 * Numbered places with dwell (labelled as the user's estimate, spec [T9]), up/down and remove. Up/down buttons are the
 * keyboard and touch way to reorder (no drag in the MVP); with "Beste Reihenfolge" the list order only matters for ties.
 */
export function PlaceList({ places, dwellDefaultMin, unreachable, unknown, onChange }: Props) {
  const t = useTranslations("tours");
  const set = (i: number, p: FormPoint) => onChange(places.map((x, j) => (j === i ? p : x)));
  return (
    <ol className="flex flex-col gap-2" data-testid="tour-places">
      {places.map((p, i) => {
        const bad = unreachable.includes(p.key) || unknown.includes(p.key);
        return (
          <li
            key={p.key}
            className={`flex flex-col gap-2 rounded-lg border p-3 ${bad ? "border-danger-line bg-danger-bg" : "border-line bg-card"}`}
          >
            <div className="flex items-start gap-3">
              <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-heading text-sm font-bold text-page">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium">{p.name}</p>
                <p className="mt-1 flex flex-wrap gap-1">
                  {p.source && <span className={chip}>{t(`source.${p.source}`)}</span>}
                </p>
                {unreachable.includes(p.key) && <p className="mt-1 text-sm text-danger-fg">{t("unreachable")}</p>}
                {unknown.includes(p.key) && <p className="mt-1 text-sm text-danger-fg">{t("unknownPlace")}</p>}
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-sm">
                <span>
                  {t("dwell")} <span className={mutedCls}>({t("dwellEstimate")})</span>
                </span>
                <select
                  className={inputCls}
                  value={p.dwellMin === undefined ? "" : String(p.dwellMin)}
                  onChange={(e) => set(i, { ...p, dwellMin: e.target.value === "" ? undefined : Number(e.target.value) })}
                >
                  <option value="">{t("dwellUseDefault", { duration: formatDuration(t, dwellDefaultMin) })}</option>
                  {choicesWith(DWELL_CHOICES, p.dwellMin).map((m) => (
                    <option key={m} value={m}>
                      {formatDuration(t, m)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={btnIcon}
                  disabled={i === 0}
                  aria-label={t("moveUp", { name: p.name })}
                  onClick={() => onChange(moveItem(places, i, -1))}
                >
                  <span aria-hidden="true">↑</span>
                </button>
                <button
                  type="button"
                  className={btnIcon}
                  disabled={i === places.length - 1}
                  aria-label={t("moveDown", { name: p.name })}
                  onClick={() => onChange(moveItem(places, i, 1))}
                >
                  <span aria-hidden="true">↓</span>
                </button>
                <button
                  type="button"
                  className={btnIcon}
                  aria-label={t("removePlace", { name: p.name })}
                  onClick={() => onChange(places.filter((_, j) => j !== i))}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
