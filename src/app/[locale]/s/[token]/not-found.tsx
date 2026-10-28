import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { linkCls, mutedCls } from "@/components/ui/styles";

/** The one 404 for unknown, expired and revoked links (no oracle between them). */
export default async function SharedNotFound() {
  const t = await getTranslations("shared");
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-3 px-4 py-12">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("notFoundTitle")}</h1>
      <p className={mutedCls}>{t("notFoundText")}</p>
      <Link href="/" className={`${linkCls} inline-flex min-h-11 items-center`}>
        {t("home")}
      </Link>
    </main>
  );
}
