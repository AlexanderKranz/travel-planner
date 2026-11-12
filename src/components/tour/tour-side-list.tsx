import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cardCls, linkCls, mutedCls, pillAccentCls } from "@/components/ui/styles";
import type { TourSummary } from "@/lib/domain/tour";
import { formatDuration, tourTitle } from "./format";
import { ModeIcon } from "./mode-icon";

/**
 * The city tours as the middle desktop column of /app: one card like the groups and purposes lists (heading inside),
 * so all three columns start on the same line (Alex, 2026-11-12). Phones and tablets use the card list instead.
 */
export function TourSideList({ tours, max, className = "" }: { tours: TourSummary[]; max: number; className?: string }) {
  const t = useTranslations("tours");
  const tt = useTranslations("trips");
  const shown = tours.slice(0, max);
  return (
    <section aria-labelledby="side-tours" className={`${cardCls} ${className}`}>
      <h2 id="side-tours" className="mb-1 font-serif text-lg font-bold text-heading">
        {t("title")}
      </h2>
      {shown.length === 0 ? (
        <p className={`text-sm ${mutedCls}`}>{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {shown.map((tour) => (
            <li key={tour.id} className="flex flex-col py-1">
              <Link href={`/app/tours/${tour.id}`} className={`${linkCls} inline-flex min-h-11 items-center break-words`}>
                {tourTitle(t, tour.title, tour.city, tour.placeCount)}
              </Link>
              <span className={`flex flex-wrap items-center gap-x-2 text-sm ${mutedCls}`}>
                <ModeIcon mode={tour.mode} className="size-4 shrink-0" />
                <span>{t(`modes.${tour.mode}`)}</span>
                {tour.totalMin !== null && <span>· {formatDuration(t, tour.totalMin)}</span>}
                {tour.startTime && <span>· {tour.startTime}</span>}
                {(tour.outdated || tour.computedAt === null) && (
                  <span className={pillAccentCls}>{tour.computedAt === null ? t("notComputed") : t("notRecomputed")}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <Link href="/app/tours/new" className={`${linkCls} inline-flex min-h-11 items-center text-sm`}>
          {t("newTour")}
        </Link>
        {tours.length > 0 && (
          <Link href="/app/tours" className={`${linkCls} inline-flex min-h-11 items-center text-sm`}>
            {tours.length > max ? tt("showAll", { count: tours.length }) : t("allTours")}
          </Link>
        )}
      </div>
    </section>
  );
}
