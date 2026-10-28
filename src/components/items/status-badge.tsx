import { useTranslations } from "next-intl";
import type { ItemStatus } from "@/lib/domain/items";

export const statusTone: Record<ItemStatus, string> = {
  booked: "border-ok-line bg-ok-bg text-ok-fg",
  planned: "border-info-line bg-info-bg text-info-fg",
  option: "border-warn-line bg-warn-bg text-warn-fg",
  rejected: "border-line-strong bg-sunken text-muted",
};

/** Text badge for a status (read-only views). The label is always visible, colour is only a hint. */
export function StatusBadge({ status }: { status: ItemStatus }) {
  const t = useTranslations("items.statuses");
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${statusTone[status]}`}
    >
      {t(status)}
    </span>
  );
}
