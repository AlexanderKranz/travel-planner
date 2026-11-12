"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { btnSecondary, cardCls, labelCls, mutedCls, pillAccentCls, pillCls } from "@/components/ui/styles";
import type { TourInput, TourResult, TourSight } from "@/lib/domain/tour";
import { formatKm, orderedCoords, resultRows, roundMetres, type LegRow, type Proposal } from "@/lib/tour/ui";
import { formatDuration } from "./format";
import { GoogleLinks } from "./google-links";
import { ModeIcon } from "./mode-icon";
import { TourMapPanel } from "./tour-map-panel";

export type TourResultProps = {
  /** The input the result was computed for (names, coordinates, dwell). */
  input: TourInput;
  result: TourResult;
  stopTimes: { arrive: string; leave: string }[] | null;
  byMin: number | null;
  mapStyleUrl: string | null;
  /** The form changed since (or the stored result belongs to another input): "Tour neu berechnen". */
  outdated?: boolean;
  /** ORS was not available; this is the previous result. */
  notRecomputed?: boolean;
  proposals?: Proposal[];
  droppedOverrides?: number;
  sightsPending?: boolean;
  /** Owner controls; absent in the read-only view. */
  onChangeLeg?: (from: string, to: string) => void;
  onAddSight?: (s: TourSight) => void;
  sightInTour?: (key: string) => boolean;
  canAddMore?: boolean;
  onApplyProposal?: (p: Proposal) => void;
};

/** Remount key of the map: changes with any of its inputs (route geometry, modes, stops, sights). */
function mapKey(result: TourResult, mode: string, coords: { lat: number; lon: number }[]): string {
  const text = [mode, result.order.join("|"), coords.map((c) => `${c.lat},${c.lon}`).join("|"), ...result.legs.map((l) => `${l.mode}:${l.poly ?? ""}`), ...result.sights.map((s) => `${s.key}@${s.lat},${s.lon}`)].join(";");
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}-${h >>> 0}`;
}

const warnBox = "rounded-lg border border-warn-line bg-warn-bg p-3 text-sm text-warn-fg";

/** Result of a tour (spec 2.1 step 3, sections 6 and 7): summary, map, stops and legs, nearby sights, sources. */
export function TourResultView(p: TourResultProps) {
  const t = useTranslations("tours");
  const locale = useLocale();
  const format = useFormatter();
  const { input, result } = p;
  const { stops, legs } = resultRows(input, result, p.stopTimes);
  const names = new Map(stops.map((s) => [s.key, s.name]));
  const allLegsKm = legs.every((l) => l.km !== null);
  const km = allLegsKm ? legs.reduce((s, l) => s + (l.km ?? 0), 0) : null;
  const coords = orderedCoords(input, result.order);
  const checked = (iso: string | undefined) => (iso ? format.dateTime(new Date(iso), { dateStyle: "medium" }) : null);
  const osmChecked = checked(result.source.osm);
  const sightsOpen = result.fit === "under";
  const mapPoints = coords.map((c, i) => ({ lat: c.lat, lon: c.lon, n: i + 1, name: names.get(c.key) ?? "" }));
  // A round trip ends at the start: one marker is enough there.
  const roundTrip = result.order.length > 1 && result.order.at(-1) === result.order[0];
  const markerPoints = roundTrip ? mapPoints.slice(0, -1) : mapPoints;

  return (
    <section aria-labelledby="tour-result-title" className="flex flex-col gap-4" data-testid="tour-result">
      <h2 id="tour-result-title" className="sr-only">
        {t("summary")}
      </h2>

      {/* Summary bar */}
      <div className={`${cardCls} flex flex-col gap-2`}>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <p className="flex flex-col">
            <span className={labelCls}>{t("total")}</span>
            <span className="font-serif text-2xl font-bold text-heading" data-testid="tour-total">
              {result.totalMin === null ? "–" : formatDuration(t, result.totalMin)}
            </span>
          </p>
          <p className="flex flex-col">
            <span className={labelCls}>{t("distance")}</span>
            <span className="font-serif text-2xl font-bold text-heading">{km === null ? "–" : t("km", { km: formatKm(km, locale) })}</span>
          </p>
          {/* Hidden while outdated (judged on another input); over/under only with their minutes. */}
          {!p.outdated && (result.fit === "ok" || (result.fit !== "none" && p.byMin !== null)) && (
            <span className={result.fit === "over" ? pillAccentCls : pillCls} data-testid="tour-fit">
              {result.fit === "ok"
                ? t("fit.ok")
                : t(`fit.${result.fit}`, { duration: formatDuration(t, p.byMin ?? 0) })}
            </span>
          )}
          {p.notRecomputed && <span className={pillCls}>{t("notRecomputed")}</span>}
          {result.stale && <span className={pillCls}>{t("stale")}</span>}
        </div>
        {p.outdated && (
          <p className={warnBox} data-testid="tour-outdated">
            {t("outdated")}
          </p>
        )}
        {result.sunset && <p className={warnBox}>{t("sunset", { time: result.sunset })}</p>}
        {!result.sunset && input.date && input.startTime && !input.city && <p className={`text-sm ${mutedCls}`}>{t("sunsetNeedsCity")}</p>}
        {(p.droppedOverrides ?? 0) > 0 && <p className={warnBox}>{t("overridesDropped", { count: p.droppedOverrides ?? 0 })}</p>}
      </div>

      {/* Over-limit proposals: approximate, never applied by themselves. */}
      {p.proposals && p.proposals.length > 0 && (
        <div className={`${cardCls} flex flex-col gap-2`}>
          <h3 className="font-semibold">{t("suggestionsTitle")}</h3>
          <ul className="flex flex-col gap-1">
            {p.proposals.map((x) => {
              const duration = formatDuration(t, x.totalMin);
              const text =
                x.kind === "drop"
                  ? t("suggest.drop", { name: names.get(x.key) ?? x.key, duration })
                  : x.kind === "dwell"
                    ? t("suggest.dwell", { dwell: formatDuration(t, input.dwellDefaultMin), duration })
                    : t("suggest.optimize", { duration });
              return (
                <li key={x.kind === "drop" ? `drop-${x.key}` : x.kind}>
                  {p.onApplyProposal ? (
                    <button type="button" className={`${btnSecondary} h-auto w-full justify-start text-left`} onClick={() => p.onApplyProposal?.(x)}>
                      {text}
                    </button>
                  ) : (
                    <span className="text-sm">{text}</span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className={`text-sm ${mutedCls}`}>{t("approx")}</p>
        </div>
      )}

      <div className="grid items-start gap-4 sm:grid-cols-2">
        <div className="order-first sm:sticky sm:top-4 sm:order-last">
          <TourMapPanel
            key={mapKey(result, input.mode, coords)}
            styleUrl={p.mapStyleUrl}
            legs={result.legs.map((l) => ({ poly: l.poly, dashed: l.mode !== input.mode }))}
            points={markerPoints}
            sights={result.sights.map((s) => ({ lat: s.lat, lon: s.lon, name: s.name }))}
          />
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="font-semibold">{t("stops")}</h3>
          <ol className="flex flex-col" data-testid="tour-stops">
            {stops.map((s, i) => {
              const leg = legs[i];
              return (
                <li key={`${s.key}-${i}`} className="flex flex-col">
                  <div className={`${cardCls} flex items-start gap-3 !p-3`}>
                    <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-heading text-sm font-bold text-page">
                      {s.n}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="break-words font-medium">
                        <span className="sr-only">{s.n}. </span>
                        {s.name}
                      </p>
                      <p className={`text-sm ${mutedCls}`}>
                        {s.role === "start" ? t("stopStart") : s.role === "end" ? t("stopEnd") : null}
                        {s.role === "place" && (
                          <>
                            {t("dwell")}: {formatDuration(t, s.dwellMin)} ({t("dwellEstimate")})
                          </>
                        )}
                        {s.arrive && (
                          <>
                            {" · "}
                            {s.role === "place" ? t("arriveLeave", { arrive: s.arrive, leave: s.leave ?? s.arrive }) : s.arrive}
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  {leg && (
                    <LegItem
                      leg={leg}
                      fromName={names.get(leg.from) ?? leg.from}
                      toName={names.get(leg.to) ?? leg.to}
                      osmChecked={osmChecked}
                      sightsOpen={sightsOpen}
                      sightsPending={!!p.sightsPending && i === 0}
                      onChange={p.onChangeLeg}
                      onAddSight={p.onAddSight}
                      sightInTour={p.sightInTour}
                      canAddMore={p.canAddMore ?? false}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <footer className={`flex flex-col gap-2 border-t border-line pt-3 text-sm ${mutedCls}`}>
        <p>
          {t("sources")}
          {checked(result.source.ors) ? ` · ${t("checked", { date: checked(result.source.ors)! })}` : ""}
        </p>
        <p>{t("walkNote")}</p>
        <GoogleLinks points={coords} mode={input.mode} />
      </footer>
    </section>
  );
}

function LegItem({
  leg,
  fromName,
  toName,
  osmChecked,
  sightsOpen,
  sightsPending,
  onChange,
  onAddSight,
  sightInTour,
  canAddMore,
}: {
  leg: LegRow;
  fromName: string;
  toName: string;
  osmChecked: string | null;
  sightsOpen: boolean;
  sightsPending: boolean;
  onChange?: (from: string, to: string) => void;
  onAddSight?: (s: TourSight) => void;
  sightInTour?: (key: string) => boolean;
  canAddMore: boolean;
}) {
  const t = useTranslations("tours");
  const locale = useLocale();
  const ok = leg.s === "ok" && leg.min !== null;
  return (
    <div className="ml-4 flex flex-col gap-2 border-l-2 border-dashed border-line-strong py-2 pl-5" data-testid="tour-leg">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-2 text-sm">
          <ModeIcon mode={leg.mode} />
          <span className="sr-only">{t(`modes.${leg.mode}`)}</span>
          {ok ? (
            <span>
              <strong>{formatDuration(t, leg.min!)}</strong>
              {leg.km !== null && ` · ${t("km", { km: formatKm(leg.km, locale) })}`}
              {` · ${t(`routes.${leg.route}`)}`}
            </span>
          ) : (
            <span className="text-danger">{leg.s === "no_route" || leg.s === "not_routable" ? t("noRoute") : t("legFailed")}</span>
          )}
        </span>
        {leg.overridden && <span className={pillCls}>{t("legOverride")}</span>}
        {onChange && (
          <button
            type="button"
            className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-heading underline underline-offset-2 hover:text-accent-text"
            aria-label={t("legChangeFor", { from: fromName, to: toName })}
            onClick={() => onChange(leg.from, leg.to)}
          >
            {t("legChange")}
          </button>
        )}
      </div>
      {sightsPending && <p className={`text-sm ${mutedCls}`}>{t("nearbyPending")}</p>}
      {leg.sights.length > 0 && (
        <details open={sightsOpen} className="flex flex-col gap-1">
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium">
            {t("nearby")} ({leg.sights.length})
          </summary>
          <ul className="flex flex-wrap gap-2">
            {leg.sights.map((s) => {
              const inTour = sightInTour?.(s.key) ?? false;
              return (
                <li key={s.key} className="flex max-w-full flex-col gap-0.5 rounded-lg border border-line bg-sunken px-3 py-2 text-sm">
                  <span className="break-words font-medium">{s.name}</span>
                  <span className={mutedCls}>{t("nearbyDistance", { m: roundMetres(s.m) })}</span>
                  {osmChecked && <span className={`text-xs ${mutedCls}`}>{t("nearbySource", { date: osmChecked })}</span>}
                  {onAddSight &&
                    (inTour ? (
                      <span className={`text-xs ${mutedCls}`}>{t("nearbyAdded")}</span>
                    ) : (
                      <button
                        type="button"
                        disabled={!canAddMore}
                        className="inline-flex min-h-11 items-center self-start text-sm font-semibold text-accent-text underline-offset-2 hover:underline disabled:opacity-50"
                        aria-label={t("nearbyAddFor", { name: s.name })}
                        onClick={() => onAddSight(s)}
                      >
                        {t("nearbyAdd")}
                      </button>
                    ))}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
