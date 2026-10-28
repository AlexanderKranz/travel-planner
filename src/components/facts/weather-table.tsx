import { useFormatter, useTranslations } from "next-intl";
import type { WeatherFacts } from "@/lib/domain";
import { mutedCls } from "@/components/ui/styles";
import { monthName } from "@/components/trips/trip-title";

const th = "px-2 py-2 text-left font-medium whitespace-nowrap";
const td = "px-2 py-2 whitespace-nowrap tabular-nums";

function MonthsTable({
  data,
  rows,
  caption,
  locale,
}: {
  data: WeatherFacts;
  rows: WeatherFacts["months"];
  caption: string;
  locale: string;
}) {
  const t = useTranslations("facts.weather");
  const f = useFormatter();
  const one = (n: number) => f.number(n, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  return (
    <div
      role="region"
      aria-label={caption}
      tabIndex={0}
      className="overflow-x-auto rounded-md focus-visible:outline-2 focus-visible:outline-blue-600"
    >
      <table className="w-full min-w-[30rem] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-neutral-300 dark:border-neutral-700">
            <th scope="col" className={th}>{t("month")}</th>
            <th scope="col" className={th}>{t("tMax")}</th>
            <th scope="col" className={th}>{t("tMin")}</th>
            <th scope="col" className={th}>{t("rain")}</th>
            <th scope="col" className={th}>{t("wetDays")}</th>
            <th scope="col" className={th}>{t("sun")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const selected = data.selectedMonths.includes(m.month);
            return (
              <tr
                key={m.month}
                className={`border-b border-neutral-200 last:border-0 dark:border-neutral-800 ${
                  selected ? "bg-blue-50 font-semibold dark:bg-blue-950" : ""
                }`}
              >
                <th scope="row" className={th}>
                  {monthName(m.month, locale, "long")}
                  {selected && <span className="sr-only"> ({t("selected")})</span>}
                </th>
                <td className={td}>{one(m.tMaxC)} °C</td>
                <td className={td}>{one(m.tMinC)} °C</td>
                <td className={td}>{f.number(Math.round(m.precipMm))} mm</td>
                <td className={td}>{one(m.wetDays)}</td>
                <td className={td}>{one(m.sunshineHours)} h</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function WeatherTable({ data, locale }: { data: WeatherFacts; locale: string }) {
  const t = useTranslations("facts.weather");
  const selected = data.months.filter((m) => data.selectedMonths.includes(m.month));
  const period = { from: data.period.from, to: data.period.to };
  return (
    <div className="flex flex-col gap-3">
      <p className={`text-sm ${mutedCls}`}>{t("intro", period)}</p>
      {selected.length > 0 ? (
        <>
          <MonthsTable data={data} rows={selected} caption={t("captionSelected")} locale={locale} />
          <details>
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-blue-600">
              {t("showAll")}
            </summary>
            <MonthsTable data={data} rows={data.months} caption={t("captionAll")} locale={locale} />
          </details>
        </>
      ) : (
        <MonthsTable data={data} rows={data.months} caption={t("captionAll")} locale={locale} />
      )}
    </div>
  );
}
