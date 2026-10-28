import { getTranslations } from "next-intl/server";
import { FactUnavailable } from "@/components/facts/fact-unavailable";
import { SourcesLine, sourceItem } from "@/components/facts/sources-line";
import { SummaryCard } from "@/components/facts/summary-card";
import { getSummaryFacts } from "@/lib/server/facts";
import type { PanelProps } from "./types";

export async function SummaryPanel({ trip, ctx }: PanelProps) {
  const t = await getTranslations("facts");
  const fact = await getSummaryFacts(trip, ctx);
  return (
    <article
      aria-labelledby="summary-eyebrow"
      className="order-1 min-w-0 lg:col-start-1 lg:row-start-1"
    >
      <h2
        id="summary-eyebrow"
        className="mb-2 text-xs font-semibold uppercase tracking-wide text-blue-800 dark:text-blue-300"
      >
        {t("summary.title")}
      </h2>
      {fact.status === "ok" ? (
        <>
          <SummaryCard data={fact.data} />
          <SourcesLine items={[sourceItem(fact)]} className="mt-2" />
        </>
      ) : (
        <FactUnavailable fact={fact} />
      )}
    </article>
  );
}
