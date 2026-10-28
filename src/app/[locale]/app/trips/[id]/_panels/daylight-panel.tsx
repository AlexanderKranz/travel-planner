import { getTranslations } from "next-intl/server";
import { FactPanel } from "@/components/facts/fact-panel";
import { DaylightTable } from "@/components/facts/daylight-table";
import { getDaylightFacts } from "@/lib/server/facts";
import type { PanelProps } from "./types";

export async function DaylightPanel({ trip, ctx }: PanelProps) {
  const t = await getTranslations("facts");
  const fact = await getDaylightFacts(trip, ctx);
  return (
    <FactPanel title={t("daylight.title")} fact={fact} fallbackSource="suncalc">
      {(data) => <DaylightTable data={data} />}
    </FactPanel>
  );
}
