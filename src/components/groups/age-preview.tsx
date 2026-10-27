"use client";

import { useTranslations } from "next-intl";
import { resolveGroupAges, type ResolvedAge } from "@/lib/group";
import { mutedCls } from "@/components/ui/styles";
import { draftToAgeSource, type EntryDraft } from "./draft";

export function AgePreview({
  entries,
  date,
  profileBirthdate,
}: {
  entries: EntryDraft[];
  date: string;
  profileBirthdate: string | null;
}) {
  const t = useTranslations("groups.preview");
  const rows = resolveGroupAges(entries.map(draftToAgeSource), date, profileBirthdate);

  function ageText(age: ResolvedAge) {
    if (age.status === "known") {
      return age.approximate ? t("approx", { age: age.age }) : t("exact", { age: age.age });
    }
    return age.status === "aboutMyAge" ? t("aboutMe") : t("unknown");
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
            const who = row.isSelf ? t("me") : (row.name ?? row.label ?? t("person"));
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
