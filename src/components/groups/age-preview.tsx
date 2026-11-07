"use client";

import { useTranslations } from "next-intl";
import { resolveGroupAges, type AgeRefs, type ResolvedAge } from "@/lib/group";
import { mutedCls } from "@/components/ui/styles";
import { draftToAgeSource, type EntryDraft } from "./draft";

/**
 * Ages on a date. `refs` says who `is_self` and "about my age" refer to (built as if the viewer were the trip owner, spec
 * group-sharing G24). `meId` is the viewer's own entry ("Me"); `ownerName` is set for a recipient: the group owner's
 * `is_self` row then carries that name, and "about my age" reads "about {name}'s age" until the viewer claimed an entry.
 */
export function AgePreview({
  entries,
  date,
  refs,
  meId = null,
  ownerName = null,
}: {
  entries: EntryDraft[];
  date: string;
  refs: AgeRefs;
  meId?: string | null;
  ownerName?: string | null;
}) {
  const t = useTranslations("groups.preview");
  const rows = resolveGroupAges(entries.map(draftToAgeSource), date, refs);
  const aboutOwner = refs.meIs === "groupOwner" && ownerName !== null;

  function ageText(age: ResolvedAge) {
    if (age.status === "known") {
      return age.approximate ? t("approx", { age: age.age }) : t("exact", { age: age.age });
    }
    if (age.status !== "aboutMyAge") return t("unknown");
    return aboutOwner ? t("aboutOwner", { name: ownerName }) : t("aboutMe");
  }

  return (
    <section aria-labelledby="preview-title" className="flex flex-col gap-2">
      <h2 id="preview-title" className="font-semibold">
        {t("title", { date })}
      </h2>
      {rows.length === 0 ? (
        <p className={mutedCls}>{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {rows.map((row, i) => {
            // "Me" is the viewer's own entry, not simply the is_self row (that is the owner's, for a recipient).
            const isMe = row.id !== undefined && row.id === meId;
            const isOwnerRow = row.isSelf && !isMe && ownerName !== null;
            const who = isMe ? t("me") : isOwnerRow ? ownerName : row.isSelf ? t("me") : (row.name ?? row.label ?? t("person"));
            return (
              <li key={row.id ?? i}>
                {row.kind === "composition" ? `${row.count} × ` : ""}
                {row.kind === "composition" ? (row.label ?? t("person")) : who}
                {row.kind === "member" && row.label && !row.isSelf && row.name ? ` (${row.label})` : ""}
                {": "}
                <span className="font-medium">{ageText(row.age)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
