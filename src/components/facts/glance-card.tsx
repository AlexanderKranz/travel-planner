import { useFormatter, useTranslations } from "next-intl";
import type { CountryFacts, DaylightFacts, Fact, WeatherFacts } from "@/lib/domain";
import { monthName } from "@/components/trips/trip-title";
import { labelCls, mutedCls } from "@/components/ui/styles";
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

const chipCls =
  "inline-flex items-center gap-1 rounded-full border border-line bg-page px-2.5 py-1 text-xs text-ink";

/** Fact tile: small uppercase caption, big serif value, one quiet line below (Atlas). */
function Tile({ label, value, children }: { label: string; value: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-card p-4 sm:p-5">
      <h3 className={labelCls}>{label}</h3>
      <p className="break-words font-serif text-2xl font-bold leading-tight text-heading sm:text-[1.75rem]">{value}</p>
      {children}
    </section>
  );
}

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
      <div className="grid gap-3 sm:grid-cols-3">
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
