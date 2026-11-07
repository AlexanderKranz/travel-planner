import { useFormatter, useTranslations } from "next-intl";
import { mutedCls } from "@/components/ui/styles";
import type { TravelGroup } from "@/lib/domain/group";
import type { ResolvedAge } from "@/lib/group";
import type { ResolvedRow } from "@/lib/group-text";
import { EntryLinkLine } from "./entry-link";
import { entryLinkView } from "./entry-link-view";

/**
 * The members of a group, read-only, with the labels of the VIEWER (docs/specs/group-sharing.md 1.5): their own entry is
 * "You", the group owner's `is_self` entry shows the owner's name with birthdate, linked entries show the mark, and the
 * link buttons appear where the server allows them. Used on the group page (read access) and in the trip's group block.
 * Ages in `rows` follow the trip owner's anchors, labels follow the viewer; the two are deliberately independent.
 */
export function GroupRows({
  rows,
  group,
  ownerLabel,
  tripOwnerId,
  tripOwnerLabel,
  aboutOwner,
}: {
  rows: ResolvedRow[];
  /** The saved group the rows come from (link state, viewer); null for a trip's one-off group or a parse. */
  group: Pick<TravelGroup, "access" | "myEntryId" | "ownerId" | "entries"> | null;
  /** The group owner's name for recipients (display name, else email); null = unknown. */
  ownerLabel: string | null;
  /** Owner of the trip being shown; when it is also the group owner their `is_self` row reads "(trip owner)". */
  tripOwnerId?: string;
  tripOwnerLabel?: string;
  /** "about my age" means the group owner (no entry claimed by the trip owner): name for the wording. */
  aboutOwner?: string | null;
}) {
  const t = useTranslations("sharing");
  const tp = useTranslations("groups.preview");
  const f = useFormatter();
  const date = (iso: string) => f.dateTime(new Date(`${iso}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });

  function ageText(age: ResolvedAge): string | null {
    if (age.status === "known") return age.approximate ? tp("approx", { age: age.age }) : tp("exact", { age: age.age });
    if (age.status === "aboutMyAge") return aboutOwner ? tp("aboutOwner", { name: aboutOwner }) : tp("aboutMe");
    return null;
  }

  return (
    <ul className="flex flex-col gap-3 text-sm">
      {rows.map((r, i) => {
        const entry = group && r.id ? group.entries.find((e) => e.id === r.id) : undefined;
        const view = group && entry ? entryLinkView(group, entry) : undefined;
        const ownerName = ownerLabel ?? t("groupBlock.ownerUnknown");
        let who: string;
        if (view?.who === "you") who = group?.access === "owner" ? tp("me") : t("link.you");
        else if (r.isSelf && group && group.access !== "owner") {
          who =
            tripOwnerId && group.ownerId === tripOwnerId && tripOwnerLabel
              ? t("groupBlock.self", { name: tripOwnerLabel })
              : ownerLabel
                ? t("groupBlock.groupOwner", { name: ownerLabel })
                : ownerName;
        } else if (r.isSelf && !group) who = t("groupBlock.self", { name: tripOwnerLabel ?? ownerName });
        else who = r.name ?? r.label ?? "";
        const count = r.kind === "composition" && r.count > 1 ? `${r.count} × ` : "";
        const age = ageText(r.age);
        const nameId = r.id ? `row-${r.id}` : undefined;
        return (
          <li key={r.id ?? i} className="flex min-w-0 flex-col gap-1.5 break-words">
            <span id={nameId}>
              {count}
              {who}
              {r.kind === "member" && r.label && !r.isSelf && r.name ? <span className={mutedCls}> ({r.label})</span> : null}
              {r.birthdate ? <span className={mutedCls}> · {t("groupBlock.born", { date: date(r.birthdate) })}</span> : null}
              {age ? <span className={mutedCls}> · {age}</span> : null}
            </span>
            {view && entry && (
              <EntryLinkLine entryId={entry.id} view={view} typedName={r.name ?? r.label ?? ""} nameId={nameId} showYou={false} />
            )}
          </li>
        );
      })}
    </ul>
  );
}
