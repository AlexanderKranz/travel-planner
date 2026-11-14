"use client";

import { useTranslations } from "next-intl";
import { linkCls, mutedCls } from "@/components/ui/styles";
import type { TourLeg } from "@/lib/domain/tour";
import { SOURCES } from "@/lib/facts/sources";

/**
 * A public transport leg (spec 17.1 [P3], 17.4): the stored timetable parts, "Fahrplan, keine Echtzeit" and the
 * Transitous source link, or why there is no connection with walking offered. Never a guessed time.
 */
export function TransitLegDetails({ leg, checked, onWalk }: { leg: TourLeg; checked: string | null; onWalk?: () => void }) {
  const t = useTranslations("tours.transit");
  const failed = leg.s !== "ok";
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="transit-leg">
      {leg.note === "walk_not_slower" && <p>{t("walkNotSlower")}</p>}
      {failed && (
        <p className="text-danger">{t(`why.${leg.note ?? "unavailable"}`)}</p>
      )}
      {failed && onWalk && (
        <button type="button" className={`${linkCls} inline-flex min-h-11 items-center self-start`} onClick={onWalk}>
          {t("walkInstead")}
        </button>
      )}
      {leg.transit && leg.transit.length > 0 && (
        <ol className="flex flex-col gap-1">
          {leg.transit.map((p, i) => (
            <li key={i} className="break-words">
              {p.m === "walk"
                ? t("partWalk", { to: p.to || t("destination"), dep: p.dep, arr: p.arr })
                : t("partRide", {
                    line: p.line ?? t(`vehicle.${vehicleKey(p.m)}`),
                    head: p.head ?? "none",
                    from: p.from,
                    to: p.to,
                    dep: p.dep,
                    arr: p.arr,
                    stops: p.stops ?? 0,
                  })}
            </li>
          ))}
        </ol>
      )}
      {!failed && leg.note !== "walk_not_slower" && (
        <p className={mutedCls}>
          {t("scheduled")} ·{" "}
          <a href={SOURCES.transitous.homepage!} target="_blank" rel="noopener noreferrer" className={linkCls}>
            {t("source")}
          </a>
          {checked ? ` · ${t("checked", { date: checked })}` : ""}
        </p>
      )}
    </div>
  );
}

const VEHICLES = ["BUS", "TRAM", "SUBWAY", "RAIL", "FERRY"] as const;
function vehicleKey(m: string): string {
  return (VEHICLES as readonly string[]).includes(m) ? m.toLowerCase() : "other";
}
