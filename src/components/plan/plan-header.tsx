import { useFormatter, useTranslations } from "next-intl";
import { mutedCls } from "@/components/ui/styles";
import type { Plan } from "@/lib/domain/plan";
import { AiBadge } from "./ai-badge";

const chip =
  "inline-flex items-center rounded-full border border-neutral-400 px-2.5 py-0.5 text-xs dark:border-neutral-500";

export function PlanHeader({ plan, uiLocale }: { plan: Plan; uiLocale: string }) {
  const t = useTranslations("plan");
  const f = useFormatter();
  const h = plan.header;
  const g = h.group;
  const utc = (iso: string) => new Date(`${iso}T12:00:00Z`);
  const timing =
    h.timing.kind === "date"
      ? `${f.dateTime(utc(h.timing.startDate), { dateStyle: "medium", timeZone: "UTC" })} – ${f.dateTime(utc(h.timing.endDate), { dateStyle: "medium", timeZone: "UTC" })}`
      : h.timing.kind === "months"
        ? h.timing.months.map((m) => f.dateTime(new Date(Date.UTC(2000, m - 1, 15)), { month: "long", timeZone: "UTC" })).join(", ")
        : t("datesOpen");
  return (
    <header className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="plan-title" className="text-xl font-bold">
          {t("title")}
        </h2>
        <AiBadge />
      </div>
      <p className={`text-sm ${mutedCls}`}>
        {timing} · {t("lengthDays", { count: h.lengthDays })}
        {h.purposeName ? ` · ${h.purposeName}` : ""}
      </p>
      {g && g.total > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t("groupLabel")}>
          {g.adults > 0 && <li className={chip}>{t("group.adults", { count: g.adults })}</li>}
          {g.children > 0 && <li className={chip}>{t("group.children", { count: g.children })}</li>}
          {g.toddlers > 0 && <li className={chip}>{t("group.toddlers", { count: g.toddlers })}</li>}
          {g.unknown > 0 && <li className={chip}>{t("group.unknown", { count: g.unknown })}</li>}
        </ul>
      )}
      <p className="text-sm">
        {t("aiNote", { date: f.dateTime(new Date(h.generatedAt), { dateStyle: "medium" }) })}
      </p>
      {plan.locale !== uiLocale && (
        <p className={`text-sm ${mutedCls}`}>{t("langMismatch", { language: t(`languages.${plan.locale}`) })}</p>
      )}
    </header>
  );
}
