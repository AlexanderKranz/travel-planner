import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { linkCls } from "@/components/ui/styles";
import { DeleteAccount } from "@/components/settings/delete-account";
import { DemoDeleteNote } from "@/components/settings/demo-delete-note";
import { SettingsForm } from "@/components/settings/settings-form";
import { getProfile } from "@/lib/server/profile";
import { unwrap } from "@/lib/unwrap";

export default async function SettingsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("settings");
  const ts = await getTranslations("start");
  const profile = unwrap(await getProfile(), locale);
  return (
    <main className="flex flex-col gap-8">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
      <SettingsForm profile={profile} />
      <section className="flex flex-col gap-1 rounded-[14px] border border-line bg-card p-4 sm:p-5" aria-labelledby="start-link-title">
        <h2 id="start-link-title" className="font-serif text-xl font-bold">
          {ts("link.settingsTitle")}
        </h2>
        <p className="text-muted">{ts("link.settingsHint")}</p>
        <Link href="/app/start" className={`${linkCls} inline-flex min-h-11 items-center self-start`}>
          {ts("link.settings")}
        </Link>
      </section>
      {profile.isDemo ?<DemoDeleteNote /> : <DeleteAccount />}
    </main>
  );
}
