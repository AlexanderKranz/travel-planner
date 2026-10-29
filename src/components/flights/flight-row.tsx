import { useTranslations } from "next-intl";
import { mutedCls } from "@/components/ui/styles";
import { durationParts } from "@/lib/flights/ui";

type Leg = { number: string; airline?: string | null; dep: string; arr: string; arrDayOffset: 0 | 1; blockMin: number; tooLong?: true };

/**
 * The list around FlightRows: owns the grid columns; rows use subgrid so durations and actions line up across rows
 * of one group. Phone: [text | action]; from `sm`: [text | duration | action].
 */
export function FlightList({ withAction, className = "", children }: { withAction: boolean; className?: string; children: React.ReactNode }) {
  const cols = withAction
    ? "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_auto_auto]"
    : "grid-cols-[minmax(0,1fr)] sm:grid-cols-[minmax(0,1fr)_auto]";
  return <ul className={`grid ${cols} gap-x-3 divide-y divide-neutral-200 dark:divide-neutral-800 ${className}`}>{children}</ul>;
}

/**
 * One flight as a CSS grid row (spec timed-items [D10]). Phone: line 1 = times + flight number, line 2 = duration
 * (+ extras) and the action, right-aligned. From `sm`: one line, the action in the last column of the parent FlightList
 * (subgrid), so it sits in the same place on every row. Used by the plan flights list, the facts flights panel and the ±1 day blocks.
 */
export function FlightRow({
  leg,
  action,
  extras,
  showAirline = false,
}: {
  leg: Leg;
  /** "+ Item" or the status of the matching item; absent = no action column. */
  action?: React.ReactNode;
  /** Extra info after the duration (weekdays, "over your limit"). */
  extras?: React.ReactNode;
  showAirline?: boolean;
}) {
  const t = useTranslations("facts.flights");
  const { h, m } = durationParts(leg.blockMin);
  const withAction = action !== undefined;
  return (
    <li className={`col-span-full grid grid-cols-subgrid items-center gap-y-0.5 py-1.5 text-sm ${leg.tooLong ? "text-neutral-600 dark:text-neutral-400" : ""}`}>
      <span className={`min-w-0 ${withAction ? "col-span-2 sm:col-span-1" : ""}`}>
        <span className="whitespace-nowrap font-medium tabular-nums">
          {leg.dep} – {leg.arr}
          {leg.arrDayOffset === 1 && <sup className="ml-0.5 text-xs">{t("nextDay")}</sup>}
        </span>
        <span className="mx-1.5" aria-hidden="true">·</span>
        <span className="whitespace-nowrap font-medium">{leg.number}</span>
        {showAirline && leg.airline && <span className={`ml-1.5 ${mutedCls}`}>{leg.airline}</span>}
      </span>
      <span className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 tabular-nums ${mutedCls}`}>
        <span className="whitespace-nowrap">
          <span className="sr-only">{t("duration")}: </span>
          {t("hm", { h, m })}
        </span>
        {extras}
      </span>
      {withAction && <span className="flex min-h-11 items-center justify-self-end">{action}</span>}
    </li>
  );
}
