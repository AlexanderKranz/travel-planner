import { useTranslations } from "next-intl";
import { cardCls, mutedCls } from "@/components/ui/styles";
import { PlanRunner } from "./plan-runner";

/**
 * Always-available "Regenerate plan" for the latest version (spec timed-items [D12]): secondary, asks first,
 * creates a new AI version even when nothing changed. Disabled when AI is off.
 */
export function PlanRegenerate({ tripId, locale, aiEnabled }: { tripId: string; locale: string; aiEnabled: boolean }) {
  const t = useTranslations("plan.regenerate");
  return (
    <section aria-labelledby="plan-regenerate" className={`${cardCls} flex min-w-0 flex-col gap-2`}>
      <h2 id="plan-regenerate" className="text-base font-semibold">
        {t("title")}
      </h2>
      <PlanRunner
        tripId={tripId}
        locale={locale}
        label={t("button")}
        secondary
        fresh
        disabled={!aiEnabled}
        confirm={{ text: t("confirm"), yes: t("confirmButton"), no: t("cancel") }}
      />
      {!aiEnabled && <p className={`text-sm ${mutedCls}`}>{t("disabled")}</p>}
    </section>
  );
}
