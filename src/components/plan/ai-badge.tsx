import { useTranslations } from "next-intl";

/** Small "AI" pill; the tooltip text doubles as the accessible name. */
export function AiBadge() {
  const t = useTranslations("plan");
  return (
    <span
      title={t("aiTooltip")}
      aria-label={t("aiTooltip")}
      role="img"
      className="inline-flex items-center rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-accent-soft-fg"
    >
      {t("aiBadge")}
    </span>
  );
}
