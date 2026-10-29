"use client";

import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import type { Fact, FlightDir, FlightLeg, FlightPair, FlightsFacts, NearbyDay, NearbyFlights } from "@/lib/domain";
import { btnSecondary, mutedCls } from "@/components/ui/styles";
import { flightLinks } from "@/lib/flights/links";
import { FlightList, FlightRow } from "@/components/flights/flight-row";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; fact: Fact<NearbyFlights> }
  | { kind: "error"; limited: boolean };

/** The button is offered for pairs that have a route in the schedule data (exact dates or the sample week). */
export function canCheckNearby(pair: FlightPair): boolean {
  return (pair.status === "found" || pair.perDay !== undefined);
}

function NearbyLeg({ leg }: { leg: FlightLeg }) {
  const t = useTranslations("facts.flights");
  return (
    <FlightRow leg={leg} showAirline extras={leg.tooLong ? <span className="text-xs font-medium">{t("tooLongShort")}</span> : undefined} />
  );
}

function DayBlock({
  day, mode, pair, dir, data, adults, locale,
}: { day: NearbyDay; mode: "schedule" | "proxy"; pair: FlightPair; dir: FlightDir; data: FlightsFacts; adults: number; locale: "de" | "en" }) {
  const t = useTranslations("facts.flights.nearby");
  const f = useFormatter();
  const label = f.dateTime(new Date(`${day.date}T12:00:00Z`), { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
  const hasLegs = day.legs.length > 0;
  const links = hasLegs
    ? flightLinks({
        from: pair.from,
        to: pair.to,
        out: dir === "out" ? day.date : data.outDate,
        back: dir === "back" ? day.date : data.backDate,
        adults,
        locale,
        airlineIata: pair.operators.find((o) => o.iata)?.iata,
      })
    : null;
  return (
    <div className="rounded-md border border-dashed border-neutral-400 p-2 dark:border-neutral-500">
      <h6 className="text-sm font-semibold">
        {label}
        <span className={`ml-2 text-xs font-normal ${mutedCls}`}>{t(data.basis === "trip_dates" ? (day.offset === -1 ? "dayBefore" : "dayAfter") : day.offset === -1 ? "dayBeforeSample" : "dayAfterSample")}</span>
      </h6>
      {mode === "proxy" && hasLegs && <p className={`text-xs ${mutedCls}`}>{t("proxy")}</p>}
      {!day.checked ? (
        <p className="text-sm">{t("notChecked")}</p>
      ) : hasLegs ? (
        <>
          <FlightList withAction={false}>
            {day.legs.map((l) => (
              <NearbyLeg key={`${l.number}-${l.dep}`} leg={l} />
            ))}
          </FlightList>
          {!day.complete && <p className={`text-xs ${mutedCls}`}>{t("partial")}</p>}
          {links && (
            <p className="mt-1 flex flex-wrap gap-2">
              {(["google", "skyscanner"] as const).map((k) => (
                <a key={k} href={links[k]} target="_blank" rel="noopener noreferrer" className={`${btnSecondary} flex-1 sm:flex-none`}>
                  {t(`links.${k}`, { date: f.dateTime(new Date(`${day.date}T12:00:00Z`), { timeZone: "UTC", day: "numeric", month: "short" }) })}
                  <span className="sr-only"> ({t("newTab")})</span>
                </a>
              ))}
            </p>
          )}
        </>
      ) : (
        <p className="text-sm">{day.complete ? t("none") : t("notChecked")}</p>
      )}
    </div>
  );
}

/** On-demand "check +/-1 day" for one direction of one pair; results are announced politely and grouped by date. */
export function FlightsNearby({
  tripId, pair, dir, data, adults, locale,
}: { tripId: string; pair: FlightPair; dir: FlightDir; data: FlightsFacts; adults: number; locale: "de" | "en" }) {
  const t = useTranslations("facts.flights.nearby");
  const [state, setState] = useState<State>({ kind: "idle" });

  async function run() {
    setState({ kind: "loading" });
    try {
      const q = new URLSearchParams({ dir, from: pair.from, to: pair.to, locale });
      const res = await fetch(`/api/trips/${encodeURIComponent(tripId)}/flights/nearby?${q}`, { cache: "no-store" });
      if (!res.ok) {
        setState({ kind: "error", limited: res.status === 429 });
        return;
      }
      setState({ kind: "done", fact: (await res.json()) as Fact<NearbyFlights> });
    } catch {
      setState({ kind: "error", limited: false });
    }
  }

  const loading = state.kind === "loading";
  const fact = state.kind === "done" ? state.fact : null;
  const ok = fact?.status === "ok" ? fact : null;
  return (
    <div className="mt-2">
      {!ok && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button type="button" onClick={run} disabled={loading} aria-busy={loading} className={`${btnSecondary} w-full disabled:opacity-60 sm:w-auto`}>
            {loading ? t("loading") : t(dir === "out" ? "checkOut" : "checkBack")}
          </button>
          {state.kind === "idle" && <span className={`text-xs ${mutedCls}`}>{t("hint")}</span>}
        </div>
      )}
      <div aria-live="polite" className="mt-2 flex flex-col gap-2">
        {state.kind === "error" && <p className="text-sm">{state.limited ? t("rateLimited") : t("error")}</p>}
        {fact && !ok && <p className="text-sm">{t("error")}</p>}
        {ok && (
          <>
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">
              {t(dir === "out" ? "titleOut" : "titleBack", { from: dir === "out" ? pair.from : pair.to, to: dir === "out" ? pair.to : pair.from })}
            </p>
            {ok.data.days.map((d) => (
              <DayBlock key={d.date} day={d} mode={ok.data.mode} pair={pair} dir={dir} data={data} adults={adults} locale={locale} />
            ))}
            {ok.data.quotaLimited && <p className="text-sm">{t("quotaLimited")}</p>}
          </>
        )}
      </div>
    </div>
  );
}
