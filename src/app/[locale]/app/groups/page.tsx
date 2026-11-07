import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { SharedPill } from "@/components/sharing/share-badge";
import { SharedGroups } from "@/components/sharing/shared-lists";
import { btnPrimary, cardCls, focusCls, mutedCls } from "@/components/ui/styles";
import { listGroups } from "@/lib/server/groups";
import { listSharedWithMe } from "@/lib/server/sharing";
import { unwrap } from "@/lib/unwrap";

export default async function GroupsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("groups");
  const [groupsRes, incomingRes] = await Promise.all([listGroups(), listSharedWithMe()]);
  const groups = unwrap(groupsRes, locale);
  // A failed shares read must not break the own list: the section simply stays hidden.
  const incoming = incomingRes.ok ? incomingRes.data : [];

  return (
    <main className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
        <Link href="/app/groups/new" className={btnPrimary}>
          {t("new")}
        </Link>
      </div>
      <p className={mutedCls}>{t("intro")}</p>
      {groups.length === 0 ? (
        <p className={cardCls}>{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {groups.map((g) => (
            <li key={g.id}>
              <Link
                href={`/app/groups/${g.id}`}
                className={`${cardCls} block hover:bg-hover ${focusCls}`}
              >
                <span className="block font-serif text-xl font-bold text-heading">{g.name}</span>
                <span className={`block text-sm ${mutedCls}`}>
                  {t("entryCount", { count: g.entryCount })}
                </span>
                {(g.description ?? g.notes) && (
                  <span className={`line-clamp-2 break-words text-sm ${mutedCls}`}>{g.description ?? g.notes}</span>
                )}
                {g.shareCount > 0 && (
                  <span className="mt-2 flex flex-wrap gap-1">
                    <SharedPill count={g.shareCount} />
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <SharedGroups shares={incoming} />
    </main>
  );
}
