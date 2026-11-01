import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cardCls, focusCls, mutedCls } from "@/components/ui/styles";
import type { TripSummary } from "@/lib/domain";
import { TripCardPending } from "./trip-card-pending";
import { timingLabel, tripTitle } from "./trip-title";

const chip =
  "inline-flex items-center rounded-full border border-heading/50 px-2.5 py-0.5 text-xs font-medium text-heading";

export function TripCard({ trip }: { trip: TripSummary }) {
  const t = useTranslations("trips");
  const locale = useLocale();
  const title = tripTitle(trip, t, locale);
  return (
    <Link
      href={`/app/trips/${trip.id}`}
      className={`${cardCls} relative block hover:bg-hover has-[[data-pending=true]]:bg-hover ${focusCls}`}
    >
      <TripCardPending />
      <span className="block break-words font-serif text-xl font-bold text-heading">{title}</span>
      {trip.title && <span className={`block text-sm ${mutedCls}`}>{trip.destination.name}</span>}
      <span className={`block text-sm ${mutedCls}`}>
        {timingLabel(trip.timing, locale, t)} · {t("days", { count: trip.lengthDays })}
      </span>
      {(trip.groupName || trip.purposeName) && (
        <span className="mt-2 flex flex-wrap gap-1">
          {trip.groupName && <span className={chip}>{trip.groupName}</span>}
          {trip.purposeName && <span className={chip}>{trip.purposeName}</span>}
        </span>
      )}
    </Link>
  );
}
