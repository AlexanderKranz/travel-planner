import { getTranslations } from "next-intl/server";
import { linkCls, mutedCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";

/** Unknown page (and `notFound()` outside the signed-in area). */
export default async function LocaleNotFound() {
  const t = await getTranslations("errorPage");
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 py-12">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("notFoundTitle")}</h1>
      <p className={mutedCls}>{t("notFoundText")}</p>
      <Link href="/" className={`${linkCls} inline-flex min-h-11 items-center`}>
        {t("toHome")}
      </Link>
    </main>
  );
}
