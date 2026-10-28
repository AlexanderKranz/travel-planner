import { useFormatter, useTranslations } from "next-intl";
import { mutedCls } from "@/components/ui/styles";
import type { PlanFlights as PlanFlightsData } from "@/lib/domain/plan";
import { durationParts, fittingLegs } from "@/lib/flights/ui";

/** Compact strip of the verified direct flights the plan was built on (fitting legs only). */
export function PlanFlights({ flights }: { flights: PlanFlightsData }) {
  const t = useTranslations("plan.flights");
  const f = useFormatter();
  const date = (iso: string) => f.dateTime(new Date(`${iso}T12:00:00Z`), { timeZone: "UTC", day: "numeric", month: "short" });
  const legs = fittingLegs(flights.legs);
  if (legs.length === 0) return null;
  const proxy = flights.mode.out === "proxy" || flights.mode.back === "proxy";
  const checked = f.dateTime(new Date(flights.fetchedAt), { dateStyle: "medium" });
  return (
    <section aria-labelledby="plan-flights" className="rounded-lg border border-neutral-300 p-3 text-sm dark:border-neutral-700 sm:p-4">
      <h3 id="plan-flights" className="mb-2 text-base font-semibold">
        {t("title")}
      </h3>
      <ul className="flex flex-col gap-1">
        {legs.map((l) => {
          const { h, m } = durationParts(l.blockMin);
          return (
            <li key={`${l.dir}-${l.number}-${l.dep}`} className="flex flex-wrap gap-x-2">
              <span className="font-medium">{t(l.dir, { date: date(l.dir === "out" ? flights.outDate : flights.backDate) })}</span>
              <span className="min-w-0">
                {l.number} · {l.from} {l.dep} → {l.to} {l.arr}
                {l.arrDayOffset === 1 && <sup className="ml-0.5 text-xs">{t("nextDay")}</sup>} · {t("hm", { h, m })}
              </span>
            </li>
          );
        })}
      </ul>
      <p className={`mt-2 text-xs ${mutedCls}`}>
        {proxy && <>{t("proxyNote")} · </>}
        {t("source", { date: checked })}
      </p>
    </section>
  );
}
