import { useFormatter, useTranslations } from "next-intl";
import { FlightList, FlightRow } from "@/components/flights/flight-row";
import { mutedCls } from "@/components/ui/styles";
import type { PlanFlights as PlanFlightsData } from "@/lib/domain/plan";
import { flightGroups } from "@/lib/flights/groups";
import { fittingLegs } from "@/lib/flights/ui";

type Leg = PlanFlightsData["legs"][number];

export { flightGroups };

/**
 * The verified direct flights the plan was built on (fitting legs only), one heading per direction and route
 * ("Outbound · Fri 10 July · FRA → CPH") and one grid row per flight (spec timed-items [D10]).
 */
export function PlanFlights({
  flights,
  renderAction,
}: {
  flights: PlanFlightsData;
  /** Owner-only slot per leg: "+ Item" or the status of the item that holds it. Absent on the share page. */
  renderAction?: (leg: Leg) => React.ReactNode;
}) {
  const t = useTranslations("plan.flights");
  const f = useFormatter();
  const legs = fittingLegs(flights.legs);
  if (legs.length === 0) return null;
  const date = (iso: string) =>
    f.dateTime(new Date(`${iso}T12:00:00Z`), { timeZone: "UTC", weekday: "short", day: "numeric", month: "long" });
  const proxy = flights.mode.out === "proxy" || flights.mode.back === "proxy";
  const checked = f.dateTime(new Date(flights.fetchedAt), { dateStyle: "medium" });
  return (
    <section aria-labelledby="plan-flights" className="rounded-[14px] border border-line bg-card p-4 text-sm sm:p-5">
      <h3 id="plan-flights" className="mb-3 text-lg font-bold">
        {t("title")}
      </h3>
      <div className="flex flex-col gap-3">
        {flightGroups(legs).map((g) => (
          <div key={`${g.dir}-${g.from}-${g.to}`} className="min-w-0">
            <h4 className="text-sm font-semibold">
              {t(g.dir === "out" ? "groupOut" : "groupBack", {
                date: date(g.dir === "out" ? flights.outDate : flights.backDate),
                route: `${g.from} → ${g.to}`,
              })}
            </h4>
            <FlightList withAction={!!renderAction}>
              {g.legs.map((l) => (
                <FlightRow key={`${l.number}-${l.dep}`} leg={l} action={renderAction ? (renderAction(l) ?? null) : undefined} />
              ))}
            </FlightList>
          </div>
        ))}
      </div>
      <p className={`mt-2 text-xs ${mutedCls}`}>
        {proxy && <>{t("proxyNote")} · </>}
        {t("source", { date: checked })}
      </p>
    </section>
  );
}
