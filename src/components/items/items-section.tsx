import { getTranslations } from "next-intl/server";
import { ErrorBanner } from "@/components/ui/error-banner";
import { cardCls, mutedCls } from "@/components/ui/styles";
import { computeCosts } from "@/lib/items/costs";
import { fittingLegs } from "@/lib/flights/ui";
import { listItems } from "@/lib/server/items";
import { getOwnerPlanFlights } from "@/lib/server/plan-document";
import { AddItemButton } from "./add-item-button";
import { CostSummaryView } from "./cost-summary";
import { ItemActions } from "./item-actions";
import { ItemList } from "./item-list";
import { StatusControl } from "./status-control";

/** Owner block of the trip page: cost table, items by day, add button. Works without a plan. */
export async function ItemsSection({
  tripId,
  lengthDays,
  startDate,
  partySize,
}: {
  tripId: string;
  lengthDays: number;
  startDate: string | null;
  partySize: number | null;
}) {
  const t = await getTranslations("items");
  const [res, planFlights] = await Promise.all([listItems(tripId), getOwnerPlanFlights(tripId)]);
  const ctx = { tripId, lengthDays, partySize, startDate, flights: planFlights ? fittingLegs(planFlights.legs) : [] };
  // Collapsed until the first entry (Alex, 2026-11-01); a quick add from the plan brings the full block.
  if (res.ok && res.data.length === 0) {
    return (
      <section aria-labelledby="items-title" className={`${cardCls} min-w-0 p-0`}>
        <details>
          <summary className="min-h-11 cursor-pointer px-4 py-2.5">
            <h2 id="items-title" className="inline text-lg font-bold">
              {t("title")}
            </h2>
          </summary>
          <div className="flex flex-col items-start gap-3 px-4 pb-4">
            <p className={`text-sm ${mutedCls}`}>{t("empty")}</p>
            <AddItemButton ctx={ctx} />
          </div>
        </details>
      </section>
    );
  }
  return (
    <section aria-labelledby="items-title" className={`${cardCls} flex min-w-0 flex-col gap-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="items-title" className="text-xl font-bold">
          {t("title")}
        </h2>
        <AddItemButton ctx={ctx} />
      </div>
      {!res.ok ? (
        <ErrorBanner error={res.error} />
      ) : (
        <>
          <CostSummaryView costs={computeCosts(res.data, partySize)} />
          <ItemList
            items={res.data}
            partySize={partySize}
            startDate={startDate}
            renderStatus={(i) => <StatusControl id={i.id} title={i.title} status={i.status} />}
            renderActions={(i) => <ItemActions item={i} {...ctx} />}
          />
        </>
      )}
    </section>
  );
}
