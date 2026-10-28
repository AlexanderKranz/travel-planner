import { getTranslations, setRequestLocale } from "next-intl/server";
import { DeleteAccount } from "@/components/settings/delete-account";
import { DemoDeleteNote } from "@/components/settings/demo-delete-note";
import { SettingsForm } from "@/components/settings/settings-form";
import { getProfile } from "@/lib/server/profile";
import { unwrap } from "@/lib/unwrap";

export default async function SettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("settings");
  const profile = unwrap(await getProfile(), locale);
  return (
    <main className="flex flex-col gap-8">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
      <SettingsForm profile={profile} />
      {profile.isDemo ? <DemoDeleteNote /> : <DeleteAccount />}
    </main>
  );
}
