"use client";

import Image from "next/image";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useId } from "react";
import {
  btnIcon,
  btnSecondary,
  linkCls,
  mutedCls,
} from "@/components/ui/styles";
import type { StopInfo, StopInfoView } from "@/lib/domain/stop-info";
import { osmRefOf } from "@/lib/stop-info/match";
import { stopSpeech, type SpeechPart } from "@/lib/stop-info/speak";
import { useStopInfoCtx } from "./context";

/**
 * Stop info in a tour's stop list (docs/specs/city-tour-stop-info.md section 6): a collapsed "Infos zum Ort" toggle per
 * stop with a possible match; the first expand of any stop loads the whole tour once. The card shows picture (with
 * credit), text (with its language), facts and sources; a play button reads it aloud with the device's voice.
 */
export type StopRef = { key: string; name: string; n: number };

const wikiUrl = (lang: string, title: string) =>
  `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
const commonsUrl = (file: string) =>
  `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replace(/ /g, "_"))}`;

/** Fact lines in the viewer's language (also spoken as sentences). */
function useFactLines() {
  const t = useTranslations("tours.stopInfo");
  return (info: StopInfo): string[] => {
    const f = info.facts;
    if (!f) return [];
    const out: string[] = [];
    if (f.year) out.push(t(`facts.${f.yearKind ?? "since"}`, { year: f.year }));
    if (f.architects?.length)
      out.push(t("facts.architect", { names: f.architects.join(", ") }));
    if (f.heritage) out.push(t("facts.heritage", { value: f.heritage }));
    if (f.openingHours)
      out.push(t("facts.openingHours", { value: f.openingHours }));
    return out;
  };
}

/** Spoken parts of one stop: intro and facts in the info's locale, the text in its own language. */
function useSpeechParts() {
  const t = useTranslations("tours.stopInfo");
  const facts = useFactLines();
  const ctx = useStopInfoCtx();
  const uiLocale = useLocale();
  return (stop: StopRef, info: StopInfo | undefined): SpeechPart[] =>
    stopSpeech({
      intro: t("readOut.intro", { n: stop.n, name: stop.name }),
      introLang: uiLocale,
      text: info?.text,
      textLang: info?.lang,
      facts: info ? facts(info) : [],
      textVoice: !!info?.lang && !!ctx?.speech.voiceFor(info.lang),
    });
}

function StopCard({
  info,
  stop,
  tourId,
  view,
}: {
  info: StopInfo;
  stop: StopRef;
  tourId: string;
  view: StopInfoView;
}) {
  const t = useTranslations("tours.stopInfo");
  const format = useFormatter();
  const facts = useFactLines()(info);
  const parts = useSpeechParts();
  const speech = useStopInfoCtx()?.speech;
  const id = `${tourId}:${stop.key}`;
  const reading = speech?.reading?.id === id;
  const fallback = info.lang && info.lang !== view.locale;
  const osmUsed =
    info.facts?.websiteFrom === "osm" || !!info.facts?.openingHours;
  const checked = Number.isFinite(Date.parse(info.checkedAt))
    ? format.dateTime(new Date(info.checkedAt), { dateStyle: "medium" })
    : null;

  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="stop-info-card">
      {info.image && (
        <figure className="flex flex-col gap-1">
          <Image
            src={info.image.url}
            alt=""
            width={info.image.w}
            height={info.image.h}
            sizes="(max-width: 640px) 100vw, 330px"
            className="h-auto w-full max-w-[330px] rounded-md"
          />
          <figcaption className={`text-xs ${mutedCls}`}>
            <a
              href={commonsUrl(info.image.file)}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="underline underline-offset-2"
            >
              {info.image.artist
                ? t("imageCredit", {
                    artist: info.image.artist,
                    licence: info.image.licence,
                  })
                : t("imageCreditNoArtist", { licence: info.image.licence })}
            </a>
          </figcaption>
        </figure>
      )}
      {info.text && info.lang && (
        <>
          {fallback && (
            <p className={`text-xs font-medium ${mutedCls}`}>
              {t("englishText")}
            </p>
          )}
          <p lang={info.lang} className="whitespace-pre-line break-words">
            {info.text}
          </p>
          {info.title && (
            <a
              href={wikiUrl(info.lang, info.title)}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className={`${linkCls} self-start`}
            >
              {t("more")}
            </a>
          )}
        </>
      )}
      {(facts.length > 0 || info.facts?.website) && (
        <ul className="flex flex-col gap-0.5">
          {facts.map((f) => (
            <li key={f} className="break-words">
              {f}
            </li>
          ))}
          {info.facts?.website && (
            <li>
              <a
                href={info.facts.website}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className={linkCls}
              >
                {t("facts.website")}
              </a>
            </li>
          )}
        </ul>
      )}
      {speech?.supported && (
        <div className="flex flex-wrap items-center gap-2">
          {reading ? (
            <button
              type="button"
              className={btnSecondary}
              aria-pressed={!speech.reading?.paused}
              onClick={speech.reading?.paused ? speech.resume : speech.pause}
            >
              {speech.reading?.paused
                ? t("readOut.resume")
                : t("readOut.pause")}
            </button>
          ) : (
            <button
              type="button"
              className={btnSecondary}
              aria-pressed={false}
              onClick={() => speech.speak(id, tourId, parts(stop, info))}
            >
              {t("readOut.play")}
            </button>
          )}
          {fallback && !speech.voiceFor("en") && (
            <span className={`text-xs ${mutedCls}`}>
              {t("readOut.noVoiceEn")}
            </span>
          )}
        </div>
      )}
      <p className={`text-xs ${mutedCls}`}>
        {[
          info.text
            ? `${fallback ? t("source.textEn") : t("source.text")}${info.clipped ? ` (${t("source.clipped")})` : ""}`
            : null,
          info.qid ? t("source.facts") : null,
          osmUsed ? t("source.osm") : null,
          checked ? t("source.checked", { date: checked }) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
}

/** The toggle and (when open) the card of one stop. Renders nothing outside a provider or for stops without a match. */
export function StopInfoToggle({
  tourId,
  stop,
}: {
  tourId: string;
  stop: StopRef;
}) {
  const t = useTranslations("tours.stopInfo");
  const ctx = useStopInfoCtx();
  const panelId = useId();
  if (!ctx || !osmRefOf(stop.key)) return null;
  const isOpen = ctx.open[tourId]?.has(stop.key) ?? false;
  const load = ctx.loads[tourId] ?? { status: "idle" };
  const toggle = () => {
    const known =
      load.status === "loaded" &&
      load.view.stops.some((s) => s.key === stop.key);
    if (!isOpen && load.status !== "loading" && !known) {
      ctx.load(tourId);
    }
    ctx.setOpen(tourId, stop.key, !isOpen);
  };
  const view = load.status === "loaded" ? load.view : null;
  const info = view?.stops.find((s) => s.key === stop.key);

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={toggle}
        className={`${linkCls} inline-flex min-h-11 items-center self-start text-sm`}
      >
        {t("toggle")}
      </button>
      {/* Always rendered, so aria-controls points to an element; hidden while collapsed. */}
      <div
        id={panelId}
        hidden={!isOpen}
        className="rounded-lg border border-line bg-sunken p-3"
      >
        {!isOpen ? null : load.status === "loading" ||
          load.status === "idle" ? (
          <p className={`text-sm ${mutedCls}`} role="status">
            {t("loading")}
          </p>
        ) : load.status === "error" ? (
          <p className="text-sm" role="status">
            {t("error")}
          </p>
        ) : info?.status === "ok" ? (
          <StopCard info={info} stop={stop} tourId={tourId} view={view!} />
        ) : !info && view?.pending.includes(stop.key) ? (
          <p className="text-sm">{view.limited ? t("limited") : t("notYet")}</p>
        ) : (
          <p className={`text-sm ${mutedCls}`}>{t("none")}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Tour read-out bar above the stop list, shown once any card of the tour is open: "Tour vorlesen" from the first stop
 * with info, pause/resume, "Nächster Ort" (opens and reads the next stop), stop. Live status without the text.
 */
export function TourReadOutBar({
  tourId,
  stops,
}: {
  tourId: string;
  stops: StopRef[];
}) {
  const t = useTranslations("tours.stopInfo");
  const ctx = useStopInfoCtx();
  const parts = useSpeechParts();
  if (!ctx || (ctx.open[tourId]?.size ?? 0) === 0) return null;
  const { speech } = ctx;
  if (!speech.supported)
    return <p className={`text-sm ${mutedCls}`}>{t("readOut.unsupported")}</p>;
  const load = ctx.loads[tourId];
  const view = load?.status === "loaded" ? load.view : null;
  const withInfo = stops.filter((s) =>
    view?.stops.some((i) => i.key === s.key && i.status === "ok"),
  );
  const reading = speech.reading?.tourId === tourId ? speech.reading : null;
  const current = reading
    ? withInfo.findIndex((s) => `${tourId}:${s.key}` === reading.id)
    : -1;

  const readFrom = (i: number) => {
    const s = withInfo[i];
    if (!s || !view) return;
    ctx.setOpen(tourId, s.key, true);
    speech.speak(
      `${tourId}:${s.key}`,
      tourId,
      parts(
        s,
        view.stops.find((x) => x.key === s.key),
      ),
      () => readFrom(i + 1),
    );
  };
  const name = current >= 0 ? withInfo[current].name : null;

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-line p-2">
      <div className="flex flex-wrap gap-2">
        {!reading ? (
          <button
            type="button"
            className={btnSecondary}
            disabled={withInfo.length === 0}
            onClick={() => readFrom(0)}
          >
            {t("readOut.tour")}
          </button>
        ) : (
          <>
            <button
              type="button"
              className={btnSecondary}
              aria-pressed={!reading.paused}
              onClick={reading.paused ? speech.resume : speech.pause}
            >
              {reading.paused ? t("readOut.resume") : t("readOut.pause")}
            </button>
            <button
              type="button"
              className={btnSecondary}
              disabled={current < 0 || current + 1 >= withInfo.length}
              onClick={() => readFrom(current + 1)}
            >
              {t("readOut.next")}
            </button>
            <button type="button" className={btnIcon} onClick={speech.stop}>
              {t("readOut.stop")}
            </button>
          </>
        )}
      </div>
      <p className={`text-xs ${mutedCls}`} aria-live="polite">
        {name ? t("readOut.reading", { name }) : t("readOut.voiceNote")}
      </p>
    </div>
  );
}
