import { useTranslations } from "next-intl";
import { cardCls, mutedCls } from "@/components/ui/styles";
import type { PlanState } from "@/lib/domain/plan";
import { BudgetLine } from "./budget-line";
import { budgetExhausted } from "./helpers";
import { PlanRunner } from "./plan-runner";

/** Shown while the trip has no plan yet: explanation, create button, reasons it may be disabled. */
export function PlanEmpty({
  state,
  locale,
  tooLong,
}: {
  state: PlanState;
  locale: string;
  tooLong: boolean;
}) {
  const t = useTranslations("plan");
  const reason = !state.aiEnabled
    ? "aiDisabled"
    : tooLong
      ? "tooLong"
      : budgetExhausted(state.budget)
        ? "budget"
        : null;
  return (
    <section aria-labelledby="plan-title" className={`${cardCls} flex min-w-0 flex-col gap-3`}>
      <h2 id="plan-title" className="text-xl font-bold">
        {t("title")}
      </h2>
      <p className="max-w-prose text-sm">{t("empty.body")}</p>
      {reason ? (
        <p role="note" className={`text-sm ${mutedCls}`}>
          {t(`empty.${reason}`)}
        </p>
      ) : null}
      <PlanRunner
        tripId={state.tripId}
        locale={locale}
        label={t("empty.create")}
        initialBusy={state.busy}
        disabled={reason !== null}
      />
      {state.aiEnabled && <BudgetLine budget={state.budget} />}
    </section>
  );
}
