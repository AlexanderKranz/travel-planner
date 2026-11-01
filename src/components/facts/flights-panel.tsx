import { useFormatter, useTranslations } from "next-intl";
import type { Fact, FlightLeg, FlightPair, FlightsFacts } from "@/lib/domain";
import { Link } from "@/i18n/navigation";
import { btnSecondary, cardCls, linkCls, mutedCls } from "@/components/ui/styles";
import { flightLinks } from "@/lib/flights/links";
import { legsOfPair, limitHours, pairState, type PairState } from "@/lib/flights/ui";
import { FlightList, FlightRow } from "@/components/flights/flight-row";
import { FlightsNearby, canCheckNearby } from "./flights-nearby";
import { FactUnavailable } from "./fact-unavailable";
import { SourceNote } from "./source-note";

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

const badgeCls: Record<PairState, string> = {
  found: "border-ok-solid bg-ok-solid text-white",
  foundProxy: "border-warn-line bg-warn-bg text-warn-fg",
  none: "border-line-strong text-muted",
  notPublished: "border-line-strong text-muted",
  notChecked: "border-line-strong border-dashed text-muted",
};

function LegRow({ leg, maxBlockMin }: { leg: FlightLeg; maxBlockMin: number | null }) {
  const t = useTranslations("facts.flights");
  const days = new Set(leg.weekdays ?? []);
  const extras = (
    <>
      {leg.weekdays && leg.weekdays.length > 0 && (
        <span className="flex items-center gap-1">
          <span className="sr-only">{t("operatingOn")}: </span>
          {WEEKDAYS.map((d) => (
            <span
              key={d}
              aria-label={t(`weekdays.${d}`)}
              className={`inline-flex size-5 items-center justify-center rounded text-xs ${
                days.has(d)
                  ? "bg-heading text-page"
                  : "border border-line text-subtle"
              }`}
            >
              {t(`weekdays.${d}`).slice(0, 1)}
              <span className="sr-only">{days.has(d) ? "" : ` (${t("notOperating")})`}</span>
            </span>
          ))}
        </span>
      )}
      {leg.operatingDays && (
        <span className="text-xs">{t("operatingDays", { days: leg.operatingDays.days, of: leg.operatingDays.of })}</span>
      )}
      {leg.tooLong && maxBlockMin != null && (
        <span className="text-xs font-medium">{t("tooLong", { h: limitHours(maxBlockMin) })}</span>
      )}
    </>
  );
  return <FlightRow leg={leg} extras={extras} showAirline />;
}

function Direction({ title, legs, maxBlockMin }: { title: string; legs: FlightLeg[]; maxBlockMin: number | null }) {
  if (legs.length === 0) return null;
  return (
    <div>
      <h4 className="text-sm font-semibold">{title}</h4>
      <FlightList withAction={false}>
        {legs.map((l) => (
          <LegRow key={`${l.number}-${l.date}-${l.dep}`} leg={l} maxBlockMin={maxBlockMin} />
        ))}
      </FlightList>
    </div>
  );
}

function PairCard({ pair, data, adults, locale, tripId }: { pair: FlightPair; data: FlightsFacts; adults: number; locale: "de" | "en"; tripId: string }) {
  const t = useTranslations("facts.flights");
  const f = useFormatter();
  const state = pairState(pair, data.mode, data.legs);
  const date = (iso: string, opts: { dateStyle?: "medium"; weekday?: "short"; day?: "numeric"; month?: "short" | "long"; year?: "numeric" }) => f.dateTime(new Date(`${iso}T12:00:00Z`), { timeZone: "UTC", ...opts });
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
    <li className="min-w-0 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold">
          <span aria-label={`${pair.from} ${t("to")} ${pair.to}`}>
            {pair.from} → {pair.to}
          </span>
          <span className={`ml-2 text-sm font-normal ${mutedCls}`}>
            {pair.toName} · {t("gatewayKm", { km })}
          </span>
        </h3>
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
          <Direction
            title={t("groupOut", { date: date(data.outDate, { weekday: "short", day: "numeric", month: "long" }), route: `${pair.from} → ${pair.to}` })}
            legs={out}
            maxBlockMin={data.maxBlockMin}
          />
          <Direction
            title={t("groupBack", { date: date(data.backDate, { weekday: "short", day: "numeric", month: "long" }), route: `${pair.to} → ${pair.from}` })}
            legs={back}
            maxBlockMin={data.maxBlockMin}
          />
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
export function FlightsPanel({ fact, tripId, adults, locale, searchId }: { fact: Fact<FlightsFacts>; tripId: string; adults: number; locale: "de" | "en"; /** The suggestion list this trip came from: offered when no direct flight was found. */ searchId?: string }) {
  const t = useTranslations("facts.flights");
  const tb = useTranslations("trips");
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
  const noneFound = d.pairs.length > 0 && !d.pairs.some((p) => p.status === "found");
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
        <ul className="grid gap-3 xl:grid-cols-2">
          {d.pairs.map((p) => (
            <PairCard key={`${p.from}-${p.to}`} pair={p} data={d} adults={adults} locale={locale} tripId={tripId} />
          ))}
        </ul>
      )}
      {d.quotaLimited && (
        <p role="note" className="mt-3 rounded-lg border border-info-line bg-info-bg p-2 text-sm text-info-fg">
          {t("quotaLimited")}
        </p>
      )}
      {searchId && noneFound && (
        <p className="mt-3 text-sm">
          <Link href={`/app/trips/discover/${searchId}`} className={`${linkCls} inline-flex min-h-11 items-center`}>
            {tb("backToSuggestions")}
          </Link>
        </p>
      )}
      <p className={`mt-3 text-xs ${mutedCls}`}>{t("change")}</p>
      <SourceNote source={fact.source} sourceUrl={fact.sourceUrl} fetchedAt={fact.fetchedAt} stale={fact.stale} />
    </>,
  );
}
