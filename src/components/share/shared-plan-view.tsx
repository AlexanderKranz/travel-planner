import { useFormatter, useTranslations } from "next-intl";
import { CostSummaryView } from "@/components/items/cost-summary";
import { ItemList } from "@/components/items/item-list";
import { DayCard } from "@/components/plan/day-card";
import { PlanFactsStrip } from "@/components/plan/plan-facts-strip";
import { PlanGlanceTiles } from "@/components/plan/plan-glance-tiles";
import { PlanFlights } from "@/components/plan/plan-flights";
import { PlanHeader } from "@/components/plan/plan-header";
import { PlanNotes, PlanOpenItems, PlanPacking } from "@/components/plan/plan-lists";
import { PdfButton } from "@/components/pdf/pdf-button";
import { eyebrowCls, mutedCls } from "@/components/ui/styles";
import type { PlanDocument } from "@/lib/domain/share";
import { fixedItemsOf } from "@/lib/plan/fixed-items";
import { DriveTimesScope } from "@/components/plan/drive-times-scope";

/** Read-only plan for the public share page. Imports no owner server actions. */
export function SharedPlanView({ doc, token, uiLocale, banner }: { doc: PlanDocument; token: string; uiLocale: string; banner?: React.ReactNode }) {
  const t = useTranslations("shared");
  const ti = useTranslations("items");
  const f = useFormatter();
  const { plan } = doc;
  const h = plan.header;
  const startDate = h.timing.kind === "date" ? h.timing.startDate : null;
  const tp = useTranslations("plan");
  // Same merged rows as the owner view; only when the link shares items [D9].
  const fixed = doc.items ? fixedItemsOf(doc.items, plan.days.length) : [];
  const tn = useTranslations("nav");
  const eyebrow = [h.purposeName, h.destination].filter(Boolean).join(" · ");
  return (
    <div className="flex min-h-screen flex-col print:min-h-0">
      <div data-no-print className="bg-header text-header-fg">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-4 py-3">
          <span className="font-serif text-xl font-bold tracking-wide">{tn("appName")}</span>
        </div>
      </div>
      <div className="mx-auto flex w-full min-w-0 max-w-3xl flex-1 flex-col gap-5 px-4 py-6 sm:py-10">
        {banner}
        <header className="flex flex-col gap-3 border-b border-line pb-6">
          {eyebrow && <p className={eyebrowCls}>{eyebrow}</p>}
          <h1 className="break-words font-serif text-4xl font-bold leading-[1.05] sm:text-5xl">{h.title}</h1>
          <p className={`text-sm ${mutedCls}`}>
            {t("banner")} · {t("version", { n: doc.versionNo })} · {t("updated", { date: f.dateTime(new Date(doc.versionAt), { dateStyle: "medium" }) })}
          </p>
          <div data-no-print className="mt-1">
            <PdfButton href={`/api/share/${token}/pdf`} label={t("pdf")} busyLabel={t("pdfBusy")} errorText={t("pdfFailed")} />
          </div>
        </header>
      <DriveTimesScope
        hasDrive={Object.values(plan.places).some((p) => p.drive)}
        className="flex min-w-0 flex-col gap-4"
        header={<PlanHeader plan={plan} uiLocale={uiLocale} readOnly />}
      >
        <PlanGlanceTiles doc={doc} locale={plan.locale} />
        <ol className="flex flex-col gap-3" aria-label={tp("daysLabel")}>
          {plan.days.map((d) => (
            <DayCard key={d.n} day={d} places={plan.places} fixed={fixed} />
          ))}
        </ol>
      </DriveTimesScope>
      {plan.flights && <PlanFlights flights={plan.flights} />}
      <PlanNotes notes={plan.notes} />
      <PlanOpenItems items={plan.openItems} done={doc.openDone} />
      <PlanPacking items={plan.packing} />
      {/* Climate, daylight and time difference are in the tiles above; only the airports stay here. */}
      <PlanFactsStrip facts={{ airports: plan.facts.airports, placesFetchedAt: plan.facts.placesFetchedAt }} />
      {doc.items && (
        <section aria-labelledby="shared-items" className="flex min-w-0 flex-col gap-3">
          <h2 id="shared-items" className="text-2xl font-bold">
            {ti("title")}
          </h2>
          {doc.costs && <CostSummaryView costs={doc.costs} headingLevel={3} />}
          <ItemList items={doc.items} partySize={doc.costs?.partySize ?? null} startDate={startDate} />
        </section>
      )}
      <footer className={`border-t border-line pt-4 text-center text-xs ${mutedCls}`}>{t("footer")}</footer>
      </div>
    </div>
  );
}
