import { useTranslations } from "next-intl";
import type { ItemStatus } from "@/lib/domain/items";

export const statusTone: Record<ItemStatus, string> = {
  booked: "border-green-700 bg-green-50 text-green-950 dark:border-green-400 dark:bg-green-950 dark:text-green-100",
  planned: "border-blue-700 bg-blue-50 text-blue-950 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-100",
  option: "border-amber-700 bg-amber-50 text-amber-950 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100",
  rejected: "border-neutral-400 bg-neutral-100 text-neutral-700 dark:border-neutral-500 dark:bg-neutral-800 dark:text-neutral-300",
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
