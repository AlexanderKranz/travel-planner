import { useTranslations } from "next-intl";
import { useGroupSummaryText } from "@/components/groups/summary-text";
import { pillCls, pillSolidCls } from "@/components/ui/styles";
import type { Trip } from "@/lib/domain";
import type { ResolvedGroup } from "@/lib/group-text";

/** `id`/`name` only for a saved group; a one-off group of the trip has neither. `text` is its free text. */
export type ContextGroup = { id?: string; name?: string; text?: string; resolved: ResolvedGroup };

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
