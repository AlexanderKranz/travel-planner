import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { linkCls, mutedCls } from "@/components/ui/styles";
import type { Plan } from "@/lib/domain/plan";
import { daylightRange } from "./helpers";

/** Compact digest of the facts the plan was written from, with sources and check dates. */
export function PlanFactsStrip({ facts }: { facts: Plan["facts"] }) {
  const t = useTranslations("plan.facts");
  const f = useFormatter();
  const light = facts.daylight ? daylightRange(facts.daylight.days) : null;
  const dates = [facts.climate?.fetchedAt, facts.placesFetchedAt].filter((x): x is string => !!x).sort();
  if (!facts.climate && !light && !facts.airports?.length) return null;
  const month = (m: number) => f.dateTime(new Date(Date.UTC(2000, m - 1, 15)), { month: "short", timeZone: "UTC" });
  const num = (n: number) => f.number(n, { maximumFractionDigits: 1 });
  return (
    <section aria-labelledby="plan-facts" className="rounded-lg border border-neutral-300 p-3 text-sm dark:border-neutral-700 sm:p-4">
      <h3 id="plan-facts" className="mb-2 text-base font-semibold">
        {t("title")}
      </h3>
      <ul className="flex flex-col gap-1">
        {facts.climate && (
          <li>
            <span className="font-medium">{t("climate")}: </span>
            {facts.climate.months
              .map((m) => t("climateMonth", { month: month(m.month), tmax: Math.round(m.tMaxC), tmin: Math.round(m.tMinC), wet: num(m.wetDays) }))
              .join("; ")}
          </li>
        )}
        {light && (
          <li>
            <span className="font-medium">{t("daylight")}: </span>
            {t("daylightRange", { sunrise: light.sunrise, dusk: light.dusk })}
          </li>
        )}
        {facts.airports && facts.airports.length > 0 && (
          <li>
            <span className="font-medium">{t("airports")}: </span>
            {facts.airports.map((a) => `${a.name} (${a.iata}, ${t("km", { km: num(a.km) })})`).join("; ")}
          </li>
        )}
      </ul>
      <p className={`mt-2 text-xs ${mutedCls}`}>
        {t("sources")}
        {dates[0] && <> · {t("checked", { date: f.dateTime(new Date(dates[0]), { dateStyle: "medium" }) })}</>} ·{" "}
        <Link href="/sources" className={linkCls}>
          {t("sourcesLink")}
        </Link>
      </p>
    </section>
  );
}
