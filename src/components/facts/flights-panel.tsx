import { useFormatter, useTranslations } from "next-intl";
import type { Fact, FlightLeg, FlightPair, FlightsFacts } from "@/lib/domain";
import { Link } from "@/i18n/navigation";
import { btnSecondary, cardCls, linkCls, mutedCls } from "@/components/ui/styles";
import { flightLinks } from "@/lib/flights/links";
import { durationParts, legsOfPair, limitHours, pairState, type PairState } from "@/lib/flights/ui";
import { FlightsNearby, canCheckNearby } from "./flights-nearby";
import { FactUnavailable } from "./fact-unavailable";
import { SourceNote } from "./source-note";

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

const badgeCls: Record<PairState, string> = {
  found: "border-green-800 bg-green-800 text-white dark:border-green-300 dark:bg-green-300 dark:text-neutral-950",
  foundProxy: "border-amber-700 bg-amber-100 text-amber-950 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100",
  none: "border-neutral-400 text-neutral-700 dark:border-neutral-500 dark:text-neutral-300",
  notPublished: "border-neutral-400 text-neutral-700 dark:border-neutral-500 dark:text-neutral-300",
  notChecked: "border-neutral-400 border-dashed text-neutral-700 dark:border-neutral-500 dark:text-neutral-300",
};

function LegRow({ leg, maxBlockMin }: { leg: FlightLeg; maxBlockMin: number | null }) {
  const t = useTranslations("facts.flights");
  const { h, m } = durationParts(leg.blockMin);
  const days = new Set(leg.weekdays ?? []);
  return (
    <li
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm ${leg.tooLong ? "text-neutral-600 dark:text-neutral-400" : ""}`}
    >
      <span className="min-w-0 basis-40 grow font-medium sm:grow-0">
        <span className="whitespace-nowrap">{leg.number}</span>
        {leg.airline && <span className={`ml-1 font-normal ${mutedCls}`}>{leg.airline}</span>}
      </span>
      <span className="whitespace-nowrap tabular-nums">
        {leg.dep} → {leg.arr}
        {leg.arrDayOffset === 1 && <sup className="ml-0.5 text-xs">{t("nextDay")}</sup>}
        <span className="mx-1.5" aria-hidden="true">·</span>
        <span className="sr-only">{t("duration")}: </span>
        {t("hm", { h, m })}
      </span>
      {leg.weekdays && leg.weekdays.length > 0 && (
        <span className="flex items-center gap-1">
          <span className="sr-only">{t("operatingOn")}: </span>
          {WEEKDAYS.map((d) => (
            <span
              key={d}
              aria-label={t(`weekdays.${d}`)}
              className={`inline-flex size-5 items-center justify-center rounded text-xs ${
                days.has(d)
                  ? "bg-neutral-800 text-white dark:bg-neutral-200 dark:text-neutral-950"
                  : "border border-neutral-300 text-neutral-500 dark:border-neutral-700"
              }`}
            >
              {t(`weekdays.${d}`).slice(0, 1)}
              <span className="sr-only">{days.has(d) ? "" : ` (${t("notOperating")})`}</span>
            </span>
          ))}
        </span>
      )}
      {leg.operatingDays && (
        <span className={`text-xs ${mutedCls}`}>{t("operatingDays", { days: leg.operatingDays.days, of: leg.operatingDays.of })}</span>
      )}
      {leg.tooLong && maxBlockMin != null && (
        <span className="text-xs font-medium">{t("tooLong", { h: limitHours(maxBlockMin) })}</span>
      )}
    </li>
  );
}

function Direction({ title, legs, maxBlockMin }: { title: string; legs: FlightLeg[]; maxBlockMin: number | null }) {
  if (legs.length === 0) return null;
  return (
    <div>
      <h5 className="text-xs font-semibold uppercase tracking-wide text-neutral-600 dark:text-neutral-400">{title}</h5>
      <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {legs.map((l) => (
          <LegRow key={`${l.number}-${l.date}-${l.dep}`} leg={l} maxBlockMin={maxBlockMin} />
        ))}
      </ul>
    </div>
  );
}

function PairCard({ pair, data, adults, locale, tripId }: { pair: FlightPair; data: FlightsFacts; adults: number; locale: "de" | "en"; tripId: string }) {
  const t = useTranslations("facts.flights");
  const f = useFormatter();
  const state = pairState(pair, data.mode, data.legs);
  const date = (iso: string, opts: { dateStyle?: "medium"; day?: "numeric"; month?: "short" | "long"; year?: "numeric" }) => f.dateTime(new Date(`${iso}T12:00:00Z`), { timeZone: "UTC", ...opts });
  const out = legsOfPair(pair, data.legs, "out");
  const back = legsOfPair(pair, data.legs, "back");
  const hasFound = pair.status === "found";
  const links = hasFound
    ? flightLinks({ from: pair.from, to: pair.to, out: data.outDate, back: data.backDate, adults, locale, airlineIata: pair.operators.find((o) => o.iata)?.iata })
    : null;
  const km = f.number(pair.gatewayKm, { maximumFractionDigits: 0 });
  const stateText =
    state === "foundProxy"
      ? t("status.foundProxy", {
          date: date(data.checkedDates.out, { dateStyle: "medium" }),
          month: date(data.outDate, { month: "long", year: "numeric" }),
        })
      : t(`status.${state}`, { date: date(data.outDate, { dateStyle: "medium" }) });
  return (
    <li className="min-w-0 rounded-md border border-neutral-300 p-3 dark:border-neutral-700">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="text-base font-semibold">
          <span aria-label={`${pair.from} ${t("to")} ${pair.to}`}>
            {pair.from} → {pair.to}
          </span>
          <span className={`ml-2 text-sm font-normal ${mutedCls}`}>
            {pair.toName} · {t("gatewayKm", { km })}
          </span>
        </h4>
        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${badgeCls[state]}`}>
          {t(`badge.${state}`)}
        </span>
      </div>
      <p className={`mt-1 text-sm ${state === "found" ? mutedCls : ""}`}>{stateText}</p>
      {pair.status === "found" && (pair.operators.length > 0 || pair.perDay) && (
        <p className={`text-sm ${mutedCls}`}>
          {pair.operators.length > 0 && <>{pair.operators.map((o) => o.name).join(", ")}</>}
          {pair.operators.length > 0 && pair.perDay ? " · " : ""}
          {pair.perDay ? t("perDay", { n: f.number(pair.perDay, { maximumFractionDigits: 1 }) }) : ""}
        </p>
      )}
      {(out.length > 0 || back.length > 0) && (
        <div className="mt-2 flex flex-col gap-2">
          <Direction title={t("outbound", { date: date(data.outDate, { day: "numeric", month: "short" }) })} legs={out} maxBlockMin={data.maxBlockMin} />
          <Direction title={t("inbound", { date: date(data.backDate, { day: "numeric", month: "short" }) })} legs={back} maxBlockMin={data.maxBlockMin} />
        </div>
      )}
      {canCheckNearby(pair) && (
        <div className="mt-2 flex flex-col gap-1">
          <FlightsNearby tripId={tripId} pair={pair} dir="out" data={data} adults={adults} locale={locale} />
          <FlightsNearby tripId={tripId} pair={pair} dir="back" data={data} adults={adults} locale={locale} />
        </div>
      )}
      {links && (
        <div className="mt-2 flex flex-wrap gap-2">
          {(["google", "skyscanner", "airline"] as const).map((k) => {
            const href = links[k];
            return href ? (
              <a key={k} href={href} target="_blank" rel="noopener noreferrer" className={`${btnSecondary} flex-1 sm:flex-none`}>
                {t(`links.${k}`)}
                <span className="sr-only"> ({t("newTab")})</span>
              </a>
            ) : null;
          })}
        </div>
      )}
    </li>
  );
}

/** Direct flights per origin x gateway pair; verified, last-year proxy, not checked and none are shown distinctly. */
export function FlightsPanel({ fact, tripId, adults, locale }: { fact: Fact<FlightsFacts>; tripId: string; adults: number; locale: "de" | "en" }) {
  const t = useTranslations("facts.flights");
  const f = useFormatter();
  const title = t("title");
  const wrap = (children: React.ReactNode) => (
    <section aria-label={title} className={`${cardCls} min-w-0`}>
      <h2 className="mb-3 text-lg font-bold">{title}</h2>
      {children}
    </section>
  );
  if (fact.status !== "ok") {
    return wrap(
      <>
        {fact.reason === "no_origin" || fact.reason === "no_dates" || fact.reason === "no_location" || fact.reason === "disabled" ? (
          <div className="flex flex-col gap-1 text-sm">
            <p>{t(`unavailable.${fact.reason}`)}</p>
            <p className="flex flex-wrap gap-x-4">
              {fact.reason === "no_origin" && (
                <Link href="/settings" className={`${linkCls} inline-flex min-h-11 items-center`}>
                  {t("toSettings")}
                </Link>
              )}
              {(fact.reason === "no_origin" || fact.reason === "no_dates" || fact.reason === "no_location") && (
                <Link href={`/app/trips/${tripId}/edit`} className={`${linkCls} inline-flex min-h-11 items-center`}>
                  {t("toTripEdit")}
                </Link>
              )}
            </p>
          </div>
        ) : fact.reason === "provider_error" ? (
          <p className="text-sm">{t("unavailable.provider_error")}</p>
        ) : (
          <FactUnavailable fact={fact} />
        )}
        <SourceNote source={fact.source ?? "aerodatabox"} />
      </>,
    );
  }
  const d = fact.data;
  const date = (iso: string) => f.dateTime(new Date(`${iso}T12:00:00Z`), { timeZone: "UTC", dateStyle: "medium" });
  const basis =
    d.basis === "trip_dates"
      ? t("basisDates", { out: date(d.outDate), back: date(d.backDate) })
      : t("basisSample", { month: f.dateTime(new Date(`${d.outDate}T12:00:00Z`), { timeZone: "UTC", month: "long", year: "numeric" }) });
  return wrap(
    <>
      <p className={`mb-3 text-sm ${mutedCls}`}>{basis}</p>
      {d.gateways.length === 0 || d.pairs.length === 0 ? (
        <p className="text-sm">{t("noGateway")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {d.pairs.map((p) => (
            <PairCard key={`${p.from}-${p.to}`} pair={p} data={d} adults={adults} locale={locale} tripId={tripId} />
          ))}
        </ul>
      )}
      {d.quotaLimited && (
        <p role="note" className="mt-3 rounded-md border border-blue-600 bg-blue-50 p-2 text-sm text-blue-950 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-100">
          {t("quotaLimited")}
        </p>
      )}
      <p className={`mt-3 text-xs ${mutedCls}`}>{t("change")}</p>
      <SourceNote source={fact.source} sourceUrl={fact.sourceUrl} fetchedAt={fact.fetchedAt} stale={fact.stale} />
    </>,
  );
}
