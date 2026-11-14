"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { mutedCls } from "@/components/ui/styles";
import { wmoGroup } from "@/lib/facts/wmo";
import { inForecastRange } from "@/lib/facts/forecast-range";
import { getTourForecast, type TourForecast } from "@/lib/server/tour/forecast";

/**
 * Daily weather forecast for the tour date (spec 17.1 [P8]), with source and check date. Asked only for a saved tour
 * whose date is within the next 16 days; outside that nothing is shown (never a guess).
 */
export function TourForecastLine({ tourId, date }: { tourId: string; date: string }) {
  const t = useTranslations("tours.forecast");
  const format = useFormatter();
  // The answer is kept with the tour and date it was asked for: a pending or empty answer for a new date never shows
  // the previous date's weather.
  const [answer, setAnswer] = useState<{ key: string; f: TourForecast | null } | null>(null);
  const key = `${tourId}|${date}`;
  const wanted = inForecastRange(date);

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void getTourForecast(tourId, date).then((r) => {
      if (live) setAnswer({ key: `${tourId}|${date}`, f: r });
    });
    return () => {
      live = false;
    };
  }, [tourId, date, wanted]);

  const f = answer?.key === key ? answer.f : null;
  if (!wanted || !f || f.date !== date) return null;
  const group = wmoGroup(f.code);
  const parts = [
    group ? t(`codes.${group}`) : null,
    f.tMax !== null && f.tMin !== null ? t("temps", { max: Math.round(f.tMax), min: Math.round(f.tMin) }) : null,
    f.precipMm !== null ? t("precip", { mm: format.number(f.precipMm, { maximumFractionDigits: 1 }) }) : null,
    f.precipProb !== null ? t("prob", { p: f.precipProb }) : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className="text-sm" data-testid="tour-forecast">
      <span className="font-medium">{t("label")}</span> {parts.join(" · ")}{" "}
      <span className={mutedCls}>({t("source", { date: format.dateTime(new Date(f.fetchedAt), { dateStyle: "medium", timeStyle: "short" }) })})</span>
    </p>
  );
}
