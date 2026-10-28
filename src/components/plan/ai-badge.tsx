import { useTranslations } from "next-intl";

/** Small "AI" pill; the tooltip text doubles as the accessible name. */
export function AiBadge() {
  const t = useTranslations("plan");
  return (
    <span
      title={t("aiTooltip")}
      aria-label={t("aiTooltip")}
      role="img"
      className="inline-flex items-center rounded-full border border-violet-700 bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-950 dark:border-violet-400 dark:bg-violet-950 dark:text-violet-100"
    >
      {t("aiBadge")}
    </span>
  );
}
