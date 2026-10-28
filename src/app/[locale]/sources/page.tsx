import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { cardCls, linkCls, mutedCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import { SOURCE_IDS, SOURCES } from "@/lib/facts/sources";
import { countryDataInfo } from "@/lib/integrations/countries";

export default async function SourcesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("sources");
  const format = await getFormatter();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <Link href="/" className="inline-flex min-h-11 items-center text-sm underline underline-offset-2">
        {t("back")}
      </Link>
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p className={mutedCls}>{t("intro")}</p>
      <ul className="flex flex-col gap-3">
        {SOURCE_IDS.map((id) => {
          const meta = SOURCES[id];
          return (
            <li key={id} className={`${cardCls} flex flex-col gap-1`}>
              <h2 className="font-semibold">{t(`items.${id}.label`)}</h2>
              <p className="text-sm">{t(`items.${id}.provides`)}</p>
              <p className="text-sm">
                {t("license")}: {t(`items.${id}.license`)}
              </p>
              {id === "rest_countries" && (
                <p className="text-sm">
                  {t("builtOn", { date: format.dateTime(new Date(countryDataInfo.fetchedAt), { dateStyle: "medium" }) })}
                </p>
              )}
              <p className="flex flex-wrap gap-x-4 text-sm">
                {meta.homepage && (
                  <a href={meta.homepage} target="_blank" rel="noopener noreferrer" className={`${linkCls} inline-flex min-h-11 items-center`}>
                    {t("website")}
                  </a>
                )}
                {meta.licenseUrl && (
                  <a href={meta.licenseUrl} target="_blank" rel="noopener noreferrer" className={`${linkCls} inline-flex min-h-11 items-center`}>
                    {t("licenseText")}
                  </a>
                )}
              </p>
            </li>
          );
        })}
      </ul>
      <p className={`text-sm ${mutedCls}`}>{t("note")}</p>
    </main>
  );
}
