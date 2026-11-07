import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cardCls, linkCls, mutedCls } from "@/components/ui/styles";
import type { TripPurpose } from "@/lib/domain";
import type { TravelGroup } from "@/lib/domain/group";
import type { ResolvedGroup } from "@/lib/group-text";
import { entryLinkView } from "./entry-link-view";
import { GroupRows } from "./group-rows";

/**
 * Group and purpose of a trip the viewer does not own, or whose group is someone else's, read-only (spec sharing 4.3 and
 * group-sharing 4.4). Every member shows with the birthdate when there is one (#129); the `is_self` row is the group
 * owner with their birthdate (decision A). Labels follow the viewer, ages follow the trip owner. Server-rendered; no data
 * leaves the server except what is shown.
 */
export function SharedContext({
  group,
  saved = null,
  groupName,
  purpose,
  ownerName,
  tripOwnerId,
  groupOwnerLabel = null,
  aboutOwner = null,
  canChange,
}: {
  group: ResolvedGroup | null;
  /** The saved group (link state of the viewer); null for a one-off group, a parse or no group. */
  saved?: TravelGroup | null;
  groupName?: string;
  purpose: Pick<TripPurpose, "id" | "name" | "text" | "usable"> | null;
  /** Display name of the trip owner. */
  ownerName: string;
  tripOwnerId?: string;
  /** Display name of the group owner when the group is someone else's. */
  groupOwnerLabel?: string | null;
  /** The group owner's name while "about my age" still means them (the trip owner has no linked entry). */
  aboutOwner?: string | null;
  /** Write grantee: say why the form cannot change them. Read grantee: the whole page is read-only already. */
  canChange: boolean;
}) {
  const t = useTranslations("sharing");
  const rows = group?.rows ?? [];
  if (rows.length === 0 && !group?.notes && !purpose) return null;
  const hasClaim = !!saved && saved.entries.some((e) => entryLinkView(saved, e).action === "claim");
  return (
    <section aria-label={t("groupBlock.title")} className={`${cardCls} flex min-w-0 flex-col gap-4`} data-testid="group-block">
      {(rows.length > 0 || group?.notes) && (
        <div className="flex min-w-0 flex-col gap-2">
          <h2 className="text-lg font-bold">
            {t("groupBlock.title")}
            {groupName ? <span className={`font-sans text-sm font-normal ${mutedCls}`}> · {groupName}</span> : null}
          </h2>
          {rows.length > 0 && (
            <GroupRows
              rows={group!.rows}
              group={saved}
              ownerLabel={groupOwnerLabel}
              tripOwnerId={tripOwnerId}
              tripOwnerLabel={ownerName}
              aboutOwner={aboutOwner}
            />
          )}
          {hasClaim && <p className={`text-sm ${mutedCls}`}>{t("link.hint")}</p>}
          {group?.notes && <p className={`text-sm ${mutedCls}`}>{group.notes}</p>}
          {saved && saved.access !== "owner" && (
            <Link href={`/app/groups/${saved.id}`} className={`${linkCls} inline-flex min-h-11 items-center self-start text-sm`}>
              {t("groupBlock.openLink")}
            </Link>
          )}
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
