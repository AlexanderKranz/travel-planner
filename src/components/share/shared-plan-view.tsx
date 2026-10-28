import { useFormatter, useTranslations } from "next-intl";
import { CostSummaryView } from "@/components/items/cost-summary";
import { ItemList } from "@/components/items/item-list";
import { DayCard } from "@/components/plan/day-card";
import { PlanFactsStrip } from "@/components/plan/plan-facts-strip";
import { PlanFlights } from "@/components/plan/plan-flights";
import { PlanHeader } from "@/components/plan/plan-header";
import { PlanNotes, PlanOpenItems, PlanPacking } from "@/components/plan/plan-lists";
import { PdfButton } from "@/components/pdf/pdf-button";
import { mutedCls } from "@/components/ui/styles";
import type { PlanDocument } from "@/lib/domain/share";

/** Read-only plan for the public share page. Imports no owner server actions. */
export function SharedPlanView({ doc, token, uiLocale }: { doc: PlanDocument; token: string; uiLocale: string }) {
  const t = useTranslations("shared");
  const ti = useTranslations("items");
  const f = useFormatter();
  const { plan } = doc;
  const h = plan.header;
  const startDate = h.timing.kind === "date" ? h.timing.startDate : null;
  const tp = useTranslations("plan");
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-4 px-4 py-4 sm:py-6">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
        <p className={mutedCls}>
          {t("banner")} · {t("version", { n: doc.versionNo })} · {t("updated", { date: f.dateTime(new Date(doc.versionAt), { dateStyle: "medium" }) })}
        </p>
        <PdfButton href={`/api/share/${token}/pdf`} label={t("pdf")} busyLabel={t("pdfBusy")} errorText={t("pdfFailed")} />
      </div>
      <h1 className="text-2xl font-bold">{h.title}</h1>
      <PlanHeader plan={plan} uiLocale={uiLocale} readOnly />
      <ol className="flex flex-col gap-3" aria-label={tp("daysLabel")}>
        {plan.days.map((d) => (
          <DayCard key={d.n} day={d} places={plan.places} />
        ))}
      </ol>
      {plan.flights && <PlanFlights flights={plan.flights} />}
      <PlanNotes notes={plan.notes} />
      <PlanOpenItems items={plan.openItems} done={doc.openDone} />
      <PlanPacking items={plan.packing} />
      <PlanFactsStrip facts={plan.facts} />
      {doc.items && (
        <section aria-labelledby="shared-items" className="flex min-w-0 flex-col gap-3">
          <h2 id="shared-items" className="text-xl font-bold">
            {ti("title")}
          </h2>
          {doc.costs && <CostSummaryView costs={doc.costs} headingLevel={3} />}
          <ItemList items={doc.items} partySize={doc.costs?.partySize ?? null} startDate={startDate} />
        </section>
      )}
      <footer className={`pt-2 text-center text-xs ${mutedCls}`}>{t("footer")}</footer>
    </div>
  );
}
