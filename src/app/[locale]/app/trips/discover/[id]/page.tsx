import { getTranslations, setRequestLocale } from "next-intl/server";
import { DiscoverResults } from "@/components/discover/discover-results";
import { linkCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import { getDestinationSearch } from "@/lib/server/discover/pipeline";
import { tripsOfSearch } from "@/lib/server/discover/search-trips";
import { unwrap } from "@/lib/unwrap";

// Reading a list is quick, but the page can be the first thing a user opens after a search ran in the background.
export const maxDuration = 60;

export default async function DiscoverListPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("discover");
  const res = await getDestinationSearch(id);
  const search = unwrap(res, locale);
  const tripsByGeo = await tripsOfSearch(id);
  return (
    <main className="flex flex-col gap-4">
      <Link href="/app/trips/discover" className={`${linkCls} inline-flex min-h-11 items-center self-start text-sm`}>
        {t("backToForm")}
      </Link>
      <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
      <DiscoverResults initial={search} tripsByGeo={tripsByGeo} />
    </main>
  );
}
