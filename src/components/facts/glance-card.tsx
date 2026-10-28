import { useFormatter, useTranslations } from "next-intl";
import type { CountryFacts, DaylightFacts, Fact, WeatherFacts } from "@/lib/domain";
import { monthName } from "@/components/trips/trip-title";
import { mutedCls } from "@/components/ui/styles";
import { climateGlance, flagEmoji, glanceMonths, middleDay } from "@/lib/facts/glance";
import { SourcesLine, sourceItem } from "./sources-line";

function regionName(code: string, locale: string, fallback: string) {
  try {
    const n = new Intl.DisplayNames([locale], { type: "region", fallback: "none" }).of(code);
    return n && n.toLowerCase() !== code.toLowerCase() ? n : fallback;
  } catch {
    return fallback;
  }
}

function currencyLabel(c: CountryFacts["currencies"][number]) {
  return c.symbol && c.symbol !== c.code ? `${c.symbol} ${c.code}` : c.code;
}

function monthsLabel(months: number[], locale: string) {
  if (months.length === 0) return "";
  if (months.length === 1) return monthName(months[0], locale, "long");
  const contiguous = months.every((m, i) => i === 0 || m === months[i - 1] + 1);
  return contiguous
    ? `${monthName(months[0], locale, "long")}–${monthName(months[months.length - 1], locale, "long")}`
    : months.map((m) => monthName(m, locale)).join(", ");
}

function Row({ icon, label, children }: { icon: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 py-1">
      <dt className={`flex min-w-0 flex-1 items-baseline gap-2 text-sm ${mutedCls}`}>
        <span aria-hidden="true">{icon}</span>
        {label}
      </dt>
      <dd className="text-right text-sm font-semibold tabular-nums">{children}</dd>
    </div>
  );
}

const chipCls =
  "inline-flex items-center gap-1 rounded-full border border-neutral-300 bg-white px-2.5 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950";

export function GlanceCard({
  weather,
  daylight,
  country,
  fallbackMonth,
  locale,
}: {
  weather: Fact<WeatherFacts>;
  daylight: Fact<DaylightFacts>;
  country: Fact<CountryFacts>;
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
      {climate && (
        <section aria-label={t("climateFor", { months: monthsLabel(months.map((m) => m.month), locale) })}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-blue-800 dark:text-blue-300">
            {t("climateFor", { months: monthsLabel(months.map((m) => m.month), locale) })}
          </h3>
          <dl className="divide-y divide-neutral-200 dark:divide-neutral-800">
            <Row icon="🌡" label={t("temperature")}>
              <span className="sr-only">{tw("tMax")} </span>
              {deg(climate.tMaxC)}
              <span aria-hidden="true"> / </span>
              <span className="sr-only">, {tw("tMin")} </span>
              {deg(climate.tMinC)}
            </Row>
            <Row icon="🌧" label={tw("wetDays")}>{one(climate.wetDays)}</Row>
            <Row icon="☀️" label={tw("sun")}>{t("hoursPerDay", { h: one(climate.sunshineHours) })}</Row>
          </dl>
        </section>
      )}
      {day && (
        <section aria-label={t("daylightOn", { date: dayLabel })}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-blue-800 dark:text-blue-300">
            {t("daylightOn", { date: dayLabel })}
          </h3>
          <dl className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {day.polar ? (
              <Row icon="🌅" label={td("hours")}>{td(day.polar === "day" ? "polarDay" : "polarNight")}</Row>
            ) : (
              <>
                <Row icon="🌅" label={t("sunriseSunset")}>
                  {time(day.sunrise)}–{time(day.sunset)}
                </Row>
                <Row icon="🌆" label={td("dusk")}>{time(day.dusk)}</Row>
              </>
            )}
          </dl>
        </section>
      )}
      {c && (
        <section aria-label={tc("title")}>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-blue-800 dark:text-blue-300">
            {tc("title")}
          </h3>
          <ul className="flex flex-wrap gap-1.5">
            <li className={`${chipCls} font-semibold`}>
              {flag && <span aria-hidden="true">{flag}</span>}
              {regionName(c.code, locale, c.nameEn)}
            </li>
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
        </section>
      )}
      {reasons.length > 0 && (
        <p className={`text-xs ${mutedCls}`}>
          {t("missing")} {reasons.map((r) => tu(r)).join(" ")}
        </p>
      )}
      <SourcesLine items={[weather, daylight, country].map(sourceItem)} className="border-t border-neutral-200 pt-2 dark:border-neutral-800" />
    </div>
  );
}
