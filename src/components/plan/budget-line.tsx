import { useFormatter, useTranslations } from "next-intl";
import { mutedCls } from "@/components/ui/styles";
import type { BudgetStatus } from "@/lib/domain/plan";
import { budgetPercent } from "./helpers";

export function BudgetLine({ budget }: { budget: BudgetStatus }) {
  const t = useTranslations("plan.budget");
  const f = useFormatter();
  return (
    <p className={`text-xs ${mutedCls}`}>
      {t("line", {
        percent: budgetPercent(budget),
        time: f.dateTime(new Date(budget.resetsAt), { timeStyle: "short", timeZone: "Europe/Berlin" }),
      })}
    </p>
  );
}
