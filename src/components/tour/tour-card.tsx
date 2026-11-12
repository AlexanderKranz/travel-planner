import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cardCls, focusCls, mutedCls, pillAccentCls } from "@/components/ui/styles";
import type { TourSummary } from "@/lib/domain/tour";
import { formatDuration, tourTitle } from "./format";
import { ModeIcon } from "./mode-icon";

/** One tour in a list (/app/tours, the /app section). */
export function TourCard({ tour }: { tour: TourSummary }) {
  const t = useTranslations("tours");
  const title = tourTitle(t, tour.title, tour.city, tour.placeCount);
  return (
    <Link href={`/app/tours/${tour.id}`} className={`${cardCls} block hover:bg-hover ${focusCls}`}>
      <span className="block break-words font-serif text-xl font-bold text-heading">{title}</span>
      <span className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm ${mutedCls}`}>
        <ModeIcon mode={tour.mode} className="size-4 shrink-0" />
        <span>{t(`modes.${tour.mode}`)}</span>
        {tour.title && tour.city && <span>· {tour.city}</span>}
        <span>· {t("placeCount", { count: tour.placeCount })}</span>
        {tour.totalMin !== null && <span>· {formatDuration(t, tour.totalMin)}</span>}
        {tour.startTime && <span>· {tour.startTime}</span>}
        {(tour.outdated || tour.computedAt === null) && <span className={pillAccentCls}>{tour.computedAt === null ? t("notComputed") : t("notRecomputed")}</span>}
      </span>
    </Link>
  );
}
