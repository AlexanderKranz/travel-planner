import { getTranslations } from "next-intl/server";
import { FactPanel } from "@/components/facts/fact-panel";
import { WeatherTable } from "@/components/facts/weather-table";
import { getWeatherFacts } from "@/lib/server/facts";
import type { PanelProps } from "./types";

export async function WeatherPanel({ trip, ctx }: PanelProps) {
  const t = await getTranslations("facts");
  const fact = await getWeatherFacts(trip, ctx);
  return (
    <FactPanel title={t("weather.title")} fact={fact} fallbackSource="open_meteo">
      {(data) => <WeatherTable data={data} locale={ctx.locale} />}
    </FactPanel>
  );
}
