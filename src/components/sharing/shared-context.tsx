import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cardCls, linkCls, mutedCls } from "@/components/ui/styles";
import type { TripPurpose } from "@/lib/domain";
import type { ResolvedGroup } from "@/lib/group-text";

/**
 * Group and purpose of a shared trip, read-only (spec sharing 4.3). The `is_self` entry is the owner: shown with the
 * owner's name and the age on the travel date. Server-rendered; no data leaves the server except what is shown.
 */
export function SharedContext({
  group,
  groupName,
  purpose,
  ownerName,
  canChange,
}: {
  group: ResolvedGroup | null;
  groupName?: string;
  purpose: Pick<TripPurpose, "id" | "name" | "text" | "usable"> | null;
  ownerName: string;
  /** Write grantee: say why the form cannot change them. Read grantee: the whole page is read-only already. */
  canChange: boolean;
}) {
  const t = useTranslations("sharing");
  const rows = group?.rows ?? [];
  if (rows.length === 0 && !group?.notes && !purpose) return null;
  return (
    <section aria-label={t("groupBlock.title")} className={`${cardCls} flex min-w-0 flex-col gap-4`}>
      {(rows.length > 0 || group?.notes) && (
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-lg font-bold">
            {t("groupBlock.title")}
            {groupName ? <span className={`font-sans text-sm font-normal ${mutedCls}`}> · {groupName}</span> : null}
          </h2>
          {rows.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm">
              {rows.map((r, i) => {
                const who = r.isSelf ? t("groupBlock.self", { name: ownerName }) : (r.name ?? r.label ?? "");
                const count = r.kind === "composition" && r.count > 1 ? `${r.count} × ` : "";
                const age = r.age.status === "known" ? t("groupBlock.ageYears", { age: r.age.age }) : null;
                return (
                  <li key={r.id ?? i} className="break-words">
                    {count}
                    {who}
                    {age ? <span className={mutedCls}> · {age}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
          {group?.notes && <p className={`text-sm ${mutedCls}`}>{group.notes}</p>}
        </div>
      )}
      {purpose && (
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-lg font-bold">{t("purposeBlock.title")}</h2>
          <p className="break-words font-medium">{purpose.name}</p>
          {purpose.text && <p className={`whitespace-pre-line break-words text-sm ${mutedCls}`}>{purpose.text}</p>}
          {purpose.usable && (
            <Link href={`/app/purposes/${purpose.id}`} className={`${linkCls} inline-flex min-h-11 items-center self-start text-sm`}>
              {t("purposeBlock.openLink")}
            </Link>
          )}
        </div>
      )}
      {canChange && <p className={`text-sm ${mutedCls}`}>{t("ownerOnlyContext", { name: ownerName })}</p>}
    </section>
  );
}
