import { useFormatter, useTranslations } from "next-intl";
import { linkCls, mutedCls } from "@/components/ui/styles";
import type { SharedItem } from "@/lib/domain/items";
import { timeRange } from "@/lib/plan/fixed-items";
import { hostOf, priceLine } from "./helpers";
import { StatusBadge } from "./status-badge";

const NOTE_PREVIEW = 100;

/**
 * One compact card per item: category + title + status on the first line, price and link on the second,
 * notes folded. Server-safe: owner controls come in as slots, so the share page imports no actions.
 */
export function ItemRow({
  item,
  partySize,
  status,
  actions,
}: {
  item: SharedItem;
  partySize: number | null;
  status?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const t = useTranslations("items");
  const f = useFormatter();
  const money = (cents: number) => f.number(cents / 100, { style: "currency", currency: item.currency });
  const line = priceLine(item, partySize);
  const label = (kind: "perPerson" | "total", cents: number) =>
    t(kind === "perPerson" ? "pricePerPerson" : "priceTotal", { amount: money(cents) });
  const host = hostOf(item.url);
  const rejected = item.status === "rejected";
  return (
    <li className="min-w-0 rounded-[14px] border border-line bg-card p-3">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span
              className={`rounded bg-sunken px-1.5 py-px text-[0.7rem] font-medium uppercase tracking-wide ${mutedCls}`}
            >
              {t(`categories.${item.category}`)}
            </span>
            {item.startTime && <span className="font-medium tabular-nums">{timeRange(item.startTime, item.endTime)}</span>}
            <span className={`min-w-0 break-words font-medium ${rejected ? "line-through" : ""}`}>{item.title}</span>
          </p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm">
            {line ? (
              <>
                <span className="font-medium tabular-nums">{label(line.primary.kind, line.primary.cents)}</span>
                {line.secondary && (
                  <span className={`tabular-nums ${mutedCls}`}>
                    · {label(line.secondary.kind, line.secondary.cents)}
                    {line.sharedBy ? `, ${t("sharedBy", { count: line.sharedBy })}` : ""}
                  </span>
                )}
              </>
            ) : (
              <span className={mutedCls}>{t("noPrice")}</span>
            )}
            {item.url && host && (
              <a href={item.url} target="_blank" rel="noopener noreferrer" className={`${linkCls} break-all ${mutedCls}`}>
                {host}
                <span className="sr-only"> ({t("opensExternal")})</span>
              </a>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">{status ?? <StatusBadge status={item.status} />}</div>
      </div>
      {item.notes &&
        (item.notes.length > NOTE_PREVIEW ? (
          <details className="mt-1.5 text-sm">
            <summary className={`cursor-pointer break-words ${mutedCls}`}>{item.notes.slice(0, NOTE_PREVIEW)}…</summary>
            <p className="mt-1 whitespace-pre-line break-words">{item.notes}</p>
          </details>
        ) : (
          <p className={`mt-1.5 whitespace-pre-line break-words text-sm ${mutedCls}`}>{item.notes}</p>
        ))}
      {actions && <div className="mt-2 flex flex-wrap gap-2">{actions}</div>}
    </li>
  );
}
