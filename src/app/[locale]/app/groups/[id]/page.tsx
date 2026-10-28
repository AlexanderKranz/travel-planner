import { getTranslations, setRequestLocale } from "next-intl/server";
import { GroupEditor } from "@/components/groups/group-editor";
import { getGroup } from "@/lib/server/groups";
import { getProfile } from "@/lib/server/profile";
import { unwrap } from "@/lib/unwrap";

export default async function EditGroupPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("groups");
  const [group, profile] = await Promise.all([getGroup(id), getProfile()]);
  const g = unwrap(group, locale);
  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("editTitle")}</h1>
      <GroupEditor group={g} profileBirthdate={unwrap(profile, locale).birthdate} />
    </main>
  );
}
