import { useTranslations } from "next-intl";
import { useGroupSummaryText } from "@/components/groups/summary-text";
import { pillCls, pillSolidCls } from "@/components/ui/styles";
import type { Trip } from "@/lib/domain";
import type { ContextGroup } from "./trip-context";

/** Pills in the trip hero: length (solid), group summary and region radius (outlined). */
export function TripHeroPills({ trip, group }: { trip: Trip; group: ContextGroup | null }) {
  const t = useTranslations("trips");
  const summary = useGroupSummaryText();
  const groupText = group ? summary(group.resolved) : "";
  const d = trip.destination;
  return (
    <ul className="flex flex-wrap gap-2">
      <li className={pillSolidCls}>{t("days", { count: trip.lengthDays })}</li>
      {groupText && <li className={pillCls}>{groupText}</li>}
      {d.kind === "region" && <li className={pillCls}>{t("detail.radius", { km: d.radiusKm })}</li>}
    </ul>
  );
}
