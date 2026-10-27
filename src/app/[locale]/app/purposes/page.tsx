import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { btnPrimary, cardCls, focusCls, mutedCls } from "@/components/ui/styles";
import { listPurposes } from "@/lib/server/purposes";
import { unwrap } from "@/lib/unwrap";

export default async function PurposesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("purposes");
  const purposes = unwrap(await listPurposes(), locale);

  return (
    <main className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <Link href="/app/purposes/new" className={btnPrimary}>
          {t("new")}
        </Link>
      </div>
      <p className={mutedCls}>{t("intro")}</p>
      {purposes.length === 0 ? (
        <p className={cardCls}>{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {purposes.map((p) => (
            <li key={p.id}>
              <Link
                href={`/app/purposes/${p.id}`}
                className={`${cardCls} block hover:bg-neutral-100 dark:hover:bg-neutral-900 ${focusCls}`}
              >
                <span className="block font-semibold">{p.name}</span>
                {p.text && <span className={`block truncate text-sm ${mutedCls}`}>{p.text}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
