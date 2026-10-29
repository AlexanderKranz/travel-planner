import { getTranslations } from "next-intl/server";
import { linkCls, mutedCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";

/** Missing or foreign trip, group, purpose (and the admin page for non-admins): same 404, inside the shell. */
export default async function AppNotFound() {
  const t = await getTranslations("errorPage");
  return (
    <main className="flex w-full flex-col gap-3 py-8">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("notFoundTitle")}</h1>
      <p className={mutedCls}>{t("notFoundText")}</p>
      <Link href="/app" className={`${linkCls} inline-flex min-h-11 items-center`}>
        {t("toApp")}
      </Link>
    </main>
  );
}
