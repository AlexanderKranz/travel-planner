import { getTranslations, setRequestLocale } from "next-intl/server";
import { SharedTours } from "@/components/sharing/shared-lists";
import { TourCard } from "@/components/tour/tour-card";
import { btnPrimary, cardCls, mutedCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import { MAX_TOURS_PER_USER } from "@/lib/domain/tour";
import { listSharedWithMe } from "@/lib/server/sharing";
import { listTours } from "@/lib/server/tours";
import { unwrap } from "@/lib/unwrap";

export default async function ToursPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("tours");
  const [ownTours, incoming] = await Promise.all([listTours(), listSharedWithMe()]);
  const tours = unwrap(ownTours, locale);
  return (
    <main className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
        {tours.length < MAX_TOURS_PER_USER && (
          <Link href="/app/tours/new" className={btnPrimary}>
            {t("newTour")}
          </Link>
        )}
      </div>
      {tours.length === 0 ? (
        <p className={`${cardCls} ${mutedCls}`}>{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tours.map((tour) => (
            <li key={tour.id}>
              <TourCard tour={tour} />
            </li>
          ))}
        </ul>
      )}
      <SharedTours shares={incoming.ok ? incoming.data : []} />
    </main>
  );
}
