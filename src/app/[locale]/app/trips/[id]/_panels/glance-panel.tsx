import { getTranslations } from "next-intl/server";
import { FactDetails } from "@/components/facts/fact-details";
import { GlanceCard } from "@/components/facts/glance-card";
import { WeatherTable } from "@/components/facts/weather-table";
import { tripTimeDifference } from "@/lib/facts/time-difference";
import { getCountryFacts, getDaylightFacts, getWeatherFacts } from "@/lib/server/facts";
import type { PanelProps } from "./types";

export const glanceAsideCls = "min-w-0";

/**
 * Awaits weather, daylight and country together (cached, fast) and renders the "At a glance" tiles plus the
 * collapsed weather table. Daylight has no table: the tile shows everything needed (Alex, 2026-10-29).
 */
export async function GlancePanel({
  trip,
  ctx,
  home,
}: PanelProps & { home: { name: string | null; timezone: string | null } }) {
  const t = await getTranslations("facts");
  const [weather, daylight, country] = await Promise.all([
    getWeatherFacts(trip, ctx),
    getDaylightFacts(trip, ctx),
    getCountryFacts(trip, ctx),
  ]);
  // Home is the owner's setting: never part of the LLM input. Share page and PDF get only computed display values (plan-document.ts).
  const timeDifference = tripTimeDifference(trip, home.timezone, ctx.today);
  const homeName = home.timezone && home.name ? home.name : t("timeDifference.defaultHome");
  const fallbackMonth = Number(ctx.today.slice(5, 7));
  return (
     <div className="flex min-w-0 flex-col gap-3">
      <section aria-labelledby="glance-title" className={glanceAsideCls}>
        <h2 id="glance-title" className="sr-only">{t("glance.title")}</h2>
        <GlanceCard
          weather={weather}
          daylight={daylight}
          country={country}
          timeDifference={timeDifference}
          homeName={homeName}
          fallbackMonth={fallbackMonth}
          locale={ctx.locale}
        />
      </section>
      <FactDetails title={t("weather.detailsTitle")} fact={weather}>
        {(data) => <WeatherTable data={data} locale={ctx.locale} />}
      </FactDetails>
    </div>
  );
}
