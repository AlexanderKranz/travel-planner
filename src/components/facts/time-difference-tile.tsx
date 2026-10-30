import { useTranslations } from "next-intl";
import { formatHours, type TimeDifference } from "@/lib/facts/time-difference";
import { Tile } from "./glance-tile";

const hours = (m: number) => formatHours(m);

/** "+1 h vs. Germany", "no time difference", or both values when daylight saving differs. Computed, no source call. */
export function TimeDifferenceTile({ diff, homeName }: { diff: TimeDifference; homeName: string }) {
  const t = useTranslations("facts.timeDifference");
  const [first, ...rest] = diff.minutes;
  const varies = rest.length > 0;
  const none = !varies && first === 0;

  const value = none
    ? t("none")
    : varies
      ? t("range", { from: hours(Math.min(...diff.minutes)), to: hours(Math.max(...diff.minutes)) })
      : t("hours", { diff: hours(first) });

  return (
    <Tile label={t("title")} value={value}>
      <p className="text-sm text-muted">{t("vs", { home: homeName })}</p>
      {varies && (
        <p className="text-sm text-muted">
          {diff.byMonth ? t("byMonth") : t("changes")}
        </p>
      )}
    </Tile>
  );
}
