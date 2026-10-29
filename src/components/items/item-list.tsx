import { useFormatter, useTranslations } from "next-intl";
import { mutedCls } from "@/components/ui/styles";
import type { SharedItem } from "@/lib/domain/items";
import { dayDate, groupItems } from "./helpers";
import { ItemRow } from "./item-row";

/** Items by day, then category; rejected ones folded away. Read-only unless the owner passes slots. */
export function ItemList<T extends SharedItem>({
  items,
  partySize,
  startDate,
  renderStatus,
  renderActions,
}: {
  items: T[];
  partySize: number | null;
  startDate: string | null;
  renderStatus?: (item: T) => React.ReactNode;
  renderActions?: (item: T) => React.ReactNode;
}) {
  const t = useTranslations("items");
  const f = useFormatter();
  const { groups, rejected } = groupItems(items);
  const row = (i: T) => (
    <ItemRow key={i.id} item={i} partySize={partySize} status={renderStatus?.(i)} actions={renderActions?.(i)} />
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {groups.map((g) => {
        const iso = g.day ? dayDate(startDate, g.day) : null;
        const heading = g.day
          ? iso
            ? `${t("dayHeading", { n: g.day })} · ${f.dateTime(new Date(`${iso}T12:00:00Z`), { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" })}`
            : t("dayHeading", { n: g.day })
          : t("noDay");
        return (
          <section key={g.day ?? "none"} aria-label={heading} className="flex flex-col gap-2">
            <h3 className={`text-sm font-semibold ${mutedCls}`}>{heading}</h3>
            <ul className="flex flex-col gap-2">{g.items.map(row)}</ul>
          </section>
        );
      })}
      {rejected.length > 0 && (
        <details>
          <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">
            {t("rejectedGroup", { count: rejected.length })}
          </summary>
          <ul className="mt-1 flex flex-col gap-2">{rejected.map(row)}</ul>
        </details>
      )}
    </div>
  );
}
