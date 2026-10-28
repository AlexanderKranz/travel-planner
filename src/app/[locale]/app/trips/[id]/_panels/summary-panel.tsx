import { getTranslations } from "next-intl/server";
import { FactPanel } from "@/components/facts/fact-panel";
import { SummaryCard } from "@/components/facts/summary-card";
import { getSummaryFacts } from "@/lib/server/facts";
import type { PanelProps } from "./types";

export async function SummaryPanel({ trip, ctx }: PanelProps) {
  const t = await getTranslations("facts");
  const fact = await getSummaryFacts(trip, ctx);
  return (
    <FactPanel title={t("summary.title")} fact={fact} fallbackSource="wikivoyage">
      {(data) => <SummaryCard data={data} />}
    </FactPanel>
  );
}
