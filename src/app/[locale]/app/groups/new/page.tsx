import { getTranslations, setRequestLocale } from "next-intl/server";
import { GroupEditor } from "@/components/groups/group-editor";
import { getProfile } from "@/lib/server/profile";
import { unwrap } from "@/lib/unwrap";

export default async function NewGroupPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("groups");
  const profile = unwrap(await getProfile(), locale);
  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">{t("newTitle")}</h1>
      <GroupEditor profileBirthdate={profile.birthdate} />
    </main>
  );
}
