import { getTranslations } from "next-intl/server";
import { DaylightTable } from "@/components/facts/daylight-table";
import { FactDetails } from "@/components/facts/fact-details";
import { GlanceCard } from "@/components/facts/glance-card";
import { WeatherTable } from "@/components/facts/weather-table";
import { getCountryFacts, getDaylightFacts, getWeatherFacts } from "@/lib/server/facts";
import type { PanelProps } from "./types";

export const glanceAsideCls =
  "order-2 min-w-0 rounded-lg border border-neutral-200 bg-neutral-50 p-4 lg:col-start-2 lg:row-start-1 dark:border-neutral-800 dark:bg-neutral-900";

/**
 * Awaits weather, daylight and country together (cached, fast) and renders the "At a glance"
 * side column plus the collapsed full tables. Children are grid items of the page layout.
 */
export async function GlancePanel({ trip, ctx }: PanelProps) {
  const t = await getTranslations("facts");
  const [weather, daylight, country] = await Promise.all([
    getWeatherFacts(trip, ctx),
    getDaylightFacts(trip, ctx),
    getCountryFacts(trip, ctx),
  ]);
  const fallbackMonth = Number(ctx.today.slice(5, 7));
  return (
    <>
      <aside aria-labelledby="glance-title" className={glanceAsideCls}>
        <h2 id="glance-title" className="mb-3 text-lg font-bold">{t("glance.title")}</h2>
        <GlanceCard
          weather={weather}
          daylight={daylight}
          country={country}
          fallbackMonth={fallbackMonth}
          locale={ctx.locale}
        />
      </aside>
      {(weather.status === "ok" || daylight.status === "ok") && (
        <div className="order-4 flex min-w-0 flex-col gap-2 lg:col-span-2">
          <FactDetails title={t("weather.detailsTitle")} fact={weather}>
            {(data) => <WeatherTable data={data} locale={ctx.locale} />}
          </FactDetails>
          <FactDetails title={t("daylight.detailsTitle")} fact={daylight}>
            {(data) => <DaylightTable data={data} />}
          </FactDetails>
        </div>
      )}
    </>
  );
}
