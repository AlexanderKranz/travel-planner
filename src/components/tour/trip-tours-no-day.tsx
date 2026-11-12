import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cardCls, linkCls, mutedCls } from "@/components/ui/styles";
import { noDayBlockOf, toursWithoutDay, type LinkedTour } from "@/lib/plan/tour-blocks";
import { useTourSummary } from "./day-tour-block";

/**
 * Tours linked to the trip without a day of it (no day, or a day beyond the trip length after the trip was shortened):
 * listed under "Ohne Tag" on the trip page and not sent to the plan (city-tour 9.1, 10). Nothing when there are none.
 */
export function TripToursNoDay({ tours, lengthDays }: { tours: readonly LinkedTour[]; lengthDays: number }) {
  const t = useTranslations("tours");
  const summary = useTourSummary();
  const list = toursWithoutDay(tours, lengthDays);
  if (!list.length) return null;
  return (
    <section aria-labelledby="tours-no-day" className={`${cardCls} flex min-w-0 flex-col gap-2`} data-tours-no-day>
      <h2 id="tours-no-day" className="text-lg font-bold">
        {t("noDayTitle")}
      </h2>
      <p className={`text-sm ${mutedCls}`}>{t("noDayHint")}</p>
      <ul className="flex flex-col gap-1">
        {list.map((tour) => {
          const b = noDayBlockOf(tour);
          return (
            <li key={tour.id} className="flex min-w-0 flex-wrap items-center gap-x-3">
              <span className="min-w-0 break-words">
                {b.title ? `${b.title} · ` : ""}
                {summary(b)}
              </span>
              <Link href={`/app/tours/${tour.id}`} className={`${linkCls} inline-flex min-h-11 items-center text-sm`}>
                {t("openTour")}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
