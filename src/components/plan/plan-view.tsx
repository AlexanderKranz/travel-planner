import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { linkCls } from "@/components/ui/styles";
import type { PlanState } from "@/lib/domain/plan";
import { DayCard } from "./day-card";
import { highlightedDays } from "./helpers";
import { PlanFlights } from "./plan-flights";
import { PlanFactsStrip } from "./plan-facts-strip";
import { PlanHeader } from "./plan-header";
import { PlanNotes, PlanOpenItems, PlanPacking } from "./plan-lists";
import { PlanRunner } from "./plan-runner";

type Shown = NonNullable<PlanState["version"]>;

/** Read-only rendering of one plan version: header, banners, day cards, notes, facts digest. */
export function PlanView({ state, shown, locale }: { state: PlanState; shown: Shown; locale: string }) {
  const t = useTranslations("plan");
  const { plan, meta } = shown;
  const changed = new Set(highlightedDays(meta));
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <PlanHeader plan={plan} uiLocale={locale} />
      {!state.isLatest && (
        <p role="note" className="rounded-md border border-blue-600 bg-blue-50 p-3 text-sm text-blue-950 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-100">
          {t("viewingOld", { n: meta.versionNo })}{" "}
          <Link href={`/app/trips/${state.tripId}`} scroll={false} className={`${linkCls} inline-flex min-h-11 items-center`}>
            {t("backToLatest")}
          </Link>
        </p>
      )}
      {state.outdated && state.isLatest && (
        <div role="note" className="flex flex-col gap-2 rounded-md border border-amber-600 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100">
          <p>
            <span className="font-medium">{t("outdated.title")}</span> {t("outdated.body")}
          </p>
          <PlanRunner tripId={state.tripId} locale={locale} label={t("outdated.regenerate")} secondary disabled={!state.aiEnabled} />
        </div>
      )}
      {state.busy && <PlanRunner tripId={state.tripId} locale={locale} watchOnly />}
      <ol className="flex flex-col gap-3" aria-label={t("daysLabel")}>
        {plan.days.map((d) => (
          <DayCard key={d.n} day={d} places={plan.places} changed={changed.has(d.n)} />
        ))}
      </ol>
      <PlanNotes notes={plan.notes} />
      <PlanOpenItems items={plan.openItems} />
      <PlanPacking items={plan.packing} />
      {plan.flights && <PlanFlights flights={plan.flights} />}
      <PlanFactsStrip facts={plan.facts} />
    </div>
  );
}
