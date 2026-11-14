"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { btnSecondary, cardCls, linkCls, mutedCls, warnBox } from "@/components/ui/styles";
import type { TourInput, TourResult } from "@/lib/domain/tour";
import { getTourDirections, type TourDirections } from "@/lib/server/tour/directions";
import { buildGpx, gpxFileName } from "@/lib/tour/gpx";
import { tourPointsOf } from "@/lib/tour/points";
import { resultVersion, stepLines } from "@/lib/tour/steps";

/**
 * "Wegbeschreibung" (spec 17.1 [P2]): nothing is fetched until the button is pressed. Shows turn-by-turn steps per
 * leg and offers a GPX download, both from the same on-request answer; a changed leg says so.
 */
export function TourDirectionsPanel({
  tourId,
  title,
  input,
  result,
  onRecompute,
}: {
  tourId: string;
  title: string;
  input: TourInput;
  result: TourResult;
  /** Owner only: forced recomputation when the route changed (spec 17.4); settles when it ran, failed or did not start. */
  onRecompute?: () => Promise<unknown> | void;
}) {
  const t = useTranslations("tours");
  const format = useFormatter();
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<TourDirections | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);

  const byKey = new Map(tourPointsOf(input).points.map((p) => [p.key, p]));
  const name = (key: string) => byKey.get(key)?.name ?? key;

  async function load() {
    setBusy(true);
    setError(null);
    try {
      const res = await getTourDirections(tourId, resultVersion(result));
      if (res.ok) setData(res.data);
      else if (res.error === "not_computed") setError(t("directions.notComputed"));
      else setError(t(`errors.${res.error === "rate_limited" || res.error === "ors_unavailable" || res.error === "conflict" || res.error === "unreachable" ? res.error : "failed"}`));
    } catch {
      setError(t("errors.failed"));
    } finally {
      setBusy(false);
    }
  }

  function downloadGpx(d: TourDirections) {
    const stops = result.order.map((k) => byKey.get(k)).filter((p) => !!p).map((p) => ({ name: p!.name, lat: p!.lat, lon: p!.lon }));
    const gpx = buildGpx({ name: title, stops, legs: d.legs.map((l) => l?.poly ?? null), creator: "travel-planner" });
    const url = URL.createObjectURL(new Blob([gpx], { type: "application/gpx+xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = gpxFileName(title);
    a.click();
    // Revoked later: some browsers read the blob after the click handler has returned.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-2">
        <button type="button" className={`${btnSecondary} self-start`} onClick={() => void load()} disabled={busy} data-testid="tour-directions-button">
          {busy ? t("directions.loading") : t("directions.button")}
        </button>
        <p className={`text-sm ${mutedCls}`}>{t("directions.hint")}</p>
        {error && (
          <p role="alert" className="text-sm text-danger-fg">
            {error}
          </p>
        )}
      </div>
    );
  }

  const changed = data.legs.some((l) => l?.changed);
  const checked = format.dateTime(new Date(data.fetchedAt), { dateStyle: "medium" });
  return (
    <section aria-labelledby="tour-directions-title" className={`${cardCls} flex flex-col gap-3`} data-testid="tour-directions">
      <h3 id="tour-directions-title" className="text-lg font-bold">
        {t("directions.title")}
      </h3>
      {changed && <p className={warnBox}>{t("directions.changed")}</p>}
      {changed && onRecompute && (
        <button
          type="button"
          className={`${btnSecondary} self-start`}
          disabled={recomputing}
          onClick={() => {
            // Disabled while it runs; enabled again when it settles (busy, failed or unchanged result), so the owner
            // can retry. A changed result remounts the panel anyway.
            setRecomputing(true);
            void Promise.resolve()
              .then(() => onRecompute())
              .catch(() => undefined)
              .finally(() => setRecomputing(false));
          }}
          data-testid="tour-directions-recompute"
        >
          {t("directions.recompute")}
        </button>
      )}
      {data.legs.some((l) => l === null) && (
        // A leg had no answer (ORS down for that run): offer a new request without reloading the page.
        <button type="button" className={`${btnSecondary} self-start`} onClick={() => void load()} disabled={busy} data-testid="tour-directions-retry">
          {busy ? t("directions.loading") : t("directions.retry")}
        </button>
      )}
      {data.legs.every((l) => l !== null && l.poly !== "") ? (
        <>
          <button type="button" className={`${btnSecondary} self-start`} onClick={() => downloadGpx(data)} data-testid="tour-gpx">
            {t("directions.gpx")}
          </button>
          <p className={`text-sm ${mutedCls}`}>{t("directions.gpxHint")}</p>
        </>
      ) : (
        // A GPX with a missing leg would look complete in a navigation app: offered only when every leg has a line.
        <p className={`text-sm ${mutedCls}`} data-testid="tour-gpx-incomplete">
          {t("directions.gpxIncomplete")}
        </p>
      )}
      <ol className="flex flex-col gap-3">
        {result.legs.map((leg, i) => {
          const d = data.legs[i];
          return (
            <li key={`${leg.from}>${leg.to}`} className="flex flex-col gap-1">
              <p className="break-words font-medium">{t("directions.leg", { n: i + 1, from: name(leg.from), to: name(leg.to) })}</p>
              {d === null ? (
                <p className={`text-sm ${mutedCls}`}>{t("directions.legFailed")}</p>
              ) : (
                <ol className="flex flex-col gap-1 pl-4">
                  {stepLines(d.steps).map((s, j) => (
                    <li key={j} className="flex flex-wrap justify-between gap-x-3 text-sm">
                      <span className="break-words">{t(`steps.${s.key}`, s.values)}</span>
                      {s.metres > 0 && <span className={`${mutedCls} tabular-nums`}>{t("directions.metres", { m: s.metres })}</span>}
                    </li>
                  ))}
                  {d.cut && (
                    <li className={`text-sm ${mutedCls}`} data-testid="tour-directions-cut">
                      {t("directions.stepsCut")}
                    </li>
                  )}
                </ol>
              )}
            </li>
          );
        })}
      </ol>
      <p className={`text-sm ${mutedCls}`}>
        {t("routeCredit")} · {t("checked", { date: checked })}
        {data.stale ? ` · ${t("stale")}` : ""}
      </p>
      <a href="#tour-result-title" className={`${linkCls} text-sm`}>
        {t("directions.backToTop")}
      </a>
    </section>
  );
}
