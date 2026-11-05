import { useTranslations } from "next-intl";
import type { Person, ShareAccess } from "@/lib/domain/sharing";
import { personLabel } from "./helpers";

const tone: Record<ShareAccess, string> = {
  read: "border-info-line bg-info-bg text-info-fg",
  write: "border-ok-line bg-ok-bg text-ok-fg",
};

/** "{name} · Read-only" / "{name} · Can edit". The text is always there, colour is only a hint; wraps at 360 px. */
export function ShareBadge({ owner, access }: { owner: Pick<Person, "name" | "email">; access: ShareAccess }) {
  const t = useTranslations("sharing");
  const name = personLabel(owner);
  const level = t(`level.${access}`);
  return (
    <span
      title={t("badgeLabel", { name, level })}
      className={`inline-flex max-w-full items-center break-words rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone[access]}`}
    >
      <span className="min-w-0 break-words">{t("badge", { name, level })}</span>
    </span>
  );
}

/** "Shared · 2" on an own card that has grants. */
export function SharedPill({ count }: { count: number }) {
  const t = useTranslations("sharing");
  return (
    <span className="inline-flex items-center rounded-full border border-heading/50 px-2.5 py-0.5 text-xs font-medium text-heading">
      {t("sharedPill", { n: count })}
    </span>
  );
}
