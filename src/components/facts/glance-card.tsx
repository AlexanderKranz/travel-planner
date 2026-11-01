import { useFormatter, useTranslations } from "next-intl";
import type { CountryFacts, DaylightFacts, Fact, WeatherFacts } from "@/lib/domain";
import { mutedCls } from "@/components/ui/styles";
import { Tile } from "./glance-tile";
import { TimeDifferenceTile } from "./time-difference-tile";
import type { TimeDifference } from "@/lib/facts/time-difference";
import { climateGlance, currencyLabel, flagEmoji, glanceMonths, middleDay, monthsLabel, regionName } from "@/lib/facts/glance";
import { SourcesLine, sourceItem } from "./sources-line";

const chipCls =
  "inline-flex items-center gap-1 rounded-full border border-line bg-page px-2.5 py-1 text-xs text-ink";

export function GlanceCard({
  weather,
  daylight,
  country,
  timeDifference,
  homeName,
  fallbackMonth,
  locale,
}: {
  weather: Fact<WeatherFacts>;
  daylight: Fact<DaylightFacts>;
  country: Fact<CountryFacts>;
  /** Destination vs. home clock; null when the destination has no time zone. */
  timeDifference: TimeDifference | null;
  homeName: string;
  fallbackMonth: number;
  locale: string;
}) {
  const t = useTranslations("facts.glance");
  const tw = useTranslations("facts.weather");
  const td = useTranslations("facts.daylight");
  const tc = useTranslations("facts.country");
  const tu = useTranslations("facts.unavailable");
  const f = useFormatter();

  const months = weather.status === "ok" ? glanceMonths(weather.data, fallbackMonth) : [];
  const climate = climateGlance(months);
  const one = (n: number) => f.number(n, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const deg = (n: number) => `${f.number(Math.round(n))}°`;

  const day = daylight.status === "ok" ? middleDay(daylight.data.days) : null;
  const tz = daylight.status === "ok" ? daylight.data.timezone : undefined;
  const time = (iso: string | null) =>
    iso ? f.dateTime(new Date(iso), { hour: "2-digit", minute: "2-digit", timeZone: tz }) : "–";
  const dayLabel = day
    ? f.dateTime(new Date(`${day.date}T12:00:00Z`), { day: "numeric", month: "short", timeZone: "UTC" })
    : "";

  const reasons = [weather, daylight, country]
    .flatMap((x) => (x.status === "unavailable" ? [x.reason] : []))
    .filter((r, i, a) => a.indexOf(r) === i);

  const c = country.status === "ok" ? country.data : null;
  const flag = c ? flagEmoji(c.code) : "";
  const tzInfo = c?.timezone;
  const tzText = tzInfo
    ? [tzInfo.iana, tzInfo.utcOffsets.length ? `UTC${tzInfo.utcOffsets[0]}` : null].filter(Boolean).join(" · ") ||
      tzInfo.countryZones[0]
    : null;

  return (
    <div className="flex flex-col gap-3">
      <div className={`grid gap-3 ${timeDifference ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3"}`}>
        {climate && (
          <Tile
            label={t("climateFor", { months: monthsLabel(months.map((m) => m.month), locale) })}
            value={
              <>
                <span className="sr-only">{tw("tMax")} </span>
                {deg(climate.tMaxC)}
                <span aria-hidden="true"> / </span>
                <span className="sr-only">, {tw("tMin")} </span>
                {deg(climate.tMinC)}
              </>
            }
          >
            <p className="text-sm text-muted">
              {one(climate.wetDays)} {tw("wetDays")} · {tw("sun")}: {t("hoursPerDay", { h: one(climate.sunshineHours) })}
            </p>
          </Tile>
        )}
        {day && (
          <Tile
            label={t("daylightOn", { date: dayLabel })}
            value={
              day.polar ? td(day.polar === "day" ? "polarDay" : "polarNight") : `${time(day.sunrise)}–${time(day.sunset)}`
            }
          >
            {!day.polar && (
              <p className="text-sm text-muted">
                {td("dusk")} {time(day.dusk)}
              </p>
            )}
          </Tile>
        )}
        {c && (
          <Tile
            label={tc("title")}
            value={
              <>
                {flag && <span aria-hidden="true">{flag} </span>}
                {regionName(c.code, locale, c.nameEn)}
              </>
            }
          >
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {c.currencies.slice(0, 2).map((cur) => (
                <li key={cur.code} className={chipCls}>
                  <span aria-hidden="true">💱</span>
                  <span className="sr-only">{tc("currency")}: </span>
                  {currencyLabel(cur)}
                </li>
              ))}
              {c.callingCodes[0] && (
                <li className={chipCls}>
                  <span aria-hidden="true">📞</span>
                  <span className="sr-only">{tc("callingCode")}: </span>
                  {c.callingCodes[0]}
                </li>
              )}
              <li className={chipCls}>
                <span aria-hidden="true">🚗</span>
                <span className="sr-only">{tc("driving")}: </span>
                {tc(c.drivingSide)}
              </li>
              {tzText && (
                <li className={chipCls}>
                  <span aria-hidden="true">🕒</span>
                  <span className="sr-only">{tc("timezone")}: </span>
                  {tzText}
                </li>
              )}
            </ul>
          </Tile>
        )}
        {timeDifference && <TimeDifferenceTile diff={timeDifference} homeName={homeName} />}
      </div>
      {reasons.length > 0 && (
        <p className={`text-xs ${mutedCls}`}>
          {t("missing")} {reasons.map((r) => tu(r)).join(" ")}
        </p>
      )}
      <SourcesLine items={[weather, daylight, country].map(sourceItem)} className="" />
    </div>
  );
}
