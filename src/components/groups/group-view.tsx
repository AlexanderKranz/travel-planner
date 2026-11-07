import { useTranslations } from "next-intl";
import { LinkErrorAlert } from "@/components/sharing/link-error";
import { GroupRows } from "@/components/sharing/group-rows";
import { entryLinkView } from "@/components/sharing/entry-link-view";
import { cardCls, mutedCls } from "@/components/ui/styles";
import type { TravelGroup } from "@/lib/domain/group";
import type { AgeRefs } from "@/lib/group";
import { resolveGroup } from "@/lib/group-text";

/**
 * A shared group for a read-only recipient (docs/specs/group-sharing.md 4.2): name, text, notes and every entry with
 * birthdate and age, labels per viewer, and "That's me" where it is offered. Nothing here edits the group.
 */
export function GroupView({
  group,
  refs,
  date,
  ownerLabel,
}: {
  group: TravelGroup;
  refs: AgeRefs;
  date: string;
  ownerLabel: string | null;
}) {
  const t = useTranslations("groups");
  const ts = useTranslations("sharing");
  const resolved = resolveGroup(
    { entries: group.entries, traitKeys: group.traitKeys, notes: group.notes, description: group.description, parse: group.parse ?? null },
    date,
    refs,
  );
  const claimable = group.entries.some((e) => entryLinkView(group, e).action === "claim");
  return (
    <section aria-labelledby="group-view-title" className={`${cardCls} flex min-w-0 flex-col gap-3`} data-testid="group-view">
      <h2 id="group-view-title" className="break-words text-xl font-bold">
        {group.name}
      </h2>
      {group.description && <p className="whitespace-pre-line break-words">{group.description}</p>}
      {group.notes && <p className={`whitespace-pre-line break-words text-sm ${mutedCls}`}>{group.notes}</p>}
      <h3 className="font-semibold">{t("entriesTitle")}</h3>
      {resolved.source === "entries" ? (
        <>
          {claimable && <p className={`text-sm ${mutedCls}`}>{ts("link.hint")}</p>}
          <LinkErrorAlert />
          <GroupRows
            rows={resolved.rows}
            group={group}
            ownerLabel={ownerLabel}
            aboutOwner={refs.meIs === "groupOwner" ? ownerLabel : null}
          />
        </>
      ) : (
        <p className={mutedCls}>{t("preview.empty")}</p>
      )}
    </section>
  );
}
