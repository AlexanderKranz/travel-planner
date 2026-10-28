import { getTranslations } from "next-intl/server";
import { ErrorBanner } from "@/components/ui/error-banner";
import { MAX_PLAN_DAYS } from "@/lib/domain/plan";
import { getOwnerPlanDocument } from "@/lib/server/plan-document";
import { getPlanState } from "@/lib/server/plans";
import { budgetExhausted } from "./helpers";
import { BudgetLine } from "./budget-line";
import { PlanEmpty } from "./plan-empty";
import { PlanIterate, type IterateBlock } from "./plan-iterate";
import { PlanVersions } from "./plan-versions";
import { PlanView } from "./plan-view";
import { PlanRegenerate } from "./plan-regenerate";

/** The plan block of the trip page: empty state, or plan + iteration + version history. */
export async function PlanSection({
  tripId,
  locale,
  lengthDays,
  version,
  partySize,
  startDate = null,
}: {
  tripId: string;
  locale: string;
  lengthDays: number;
  version?: number;
  partySize: number | null;
  startDate?: string | null;
}) {
  const res = await getPlanState(tripId, version);
  if (!res.ok) {
    const t = await getTranslations("plan");
    return (
      <section aria-labelledby="plan-title" className="flex flex-col gap-3">
        <h2 id="plan-title" className="text-xl font-bold">
          {t("title")}
        </h2>
        <ErrorBanner error={res.error} />
      </section>
    );
  }
  const state = res.data;
  if (!state.version) {
    return <PlanEmpty state={state} locale={locale} tooLong={lengthDays > MAX_PLAN_DAYS} />;
  }
  const shown = state.version;
  const doc = await getOwnerPlanDocument(tripId);
  const openDone = doc?.openDone ?? [];

  const aiBlock: IterateBlock = !state.isLatest
    ? "notLatest"
    : state.busy
      ? "busy"
      : !state.aiEnabled
        ? "aiDisabled"
        : budgetExhausted(state.budget)
          ? "budget"
          : !state.canIterate
            ? "outdated"
            : null;
  const editBlock: IterateBlock = !state.isLatest ? "notLatest" : state.busy ? "busy" : null;
  const bestDay = shown.plan.days.find((d) => d.best)?.n ?? null;

  return (
    <section aria-labelledby="plan-title" className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)] lg:gap-x-8">
      <div className="min-w-0">
        <PlanView
          state={state}
          shown={shown}
          locale={locale}
          openDone={openDone}
          items={{ lengthDays, partySize, startDate, list: doc?.items ?? [], changed: doc?.itemsChanged === true }}
        />
      </div>
      {/* Sticky side column; scrolls on its own when taller than the viewport. */}
      <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain lg:pb-1">
        <PlanIterate
          key={shown.meta.versionNo}
          tripId={tripId}
          locale={locale}
          baseVersion={shown.meta.versionNo}
          dayCount={shown.plan.days.length}
          bestDay={bestDay}
          aiBlock={aiBlock}
          editBlock={editBlock}
        />
        <BudgetLine budget={state.budget} />
        <PlanVersions tripId={tripId} versions={state.versions} shown={shown.meta.versionNo} busy={state.busy} />
        {state.isLatest && !state.busy && <PlanRegenerate tripId={tripId} locale={locale} aiEnabled={state.aiEnabled} />}
      </aside>
    </section>
  );
}
