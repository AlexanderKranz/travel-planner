import { getTranslations } from "next-intl/server";
import { FactPanel } from "@/components/facts/fact-panel";
import { CountryCard } from "@/components/facts/country-card";
import { getCountryFacts } from "@/lib/server/facts";
import type { PanelProps } from "./types";

export async function CountryPanel({ trip, ctx }: PanelProps) {
  const t = await getTranslations("facts");
  const fact = await getCountryFacts(trip, ctx);
  return (
    <FactPanel title={t("country.title")} fact={fact} fallbackSource="rest_countries">
      {(data) => <CountryCard data={data} locale={ctx.locale} />}
    </FactPanel>
  );
}
