import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { AdminDashboard } from "@/components/admin/dashboard";
import { InvitesSection } from "@/components/admin/invites";
import { UsersSection } from "@/components/admin/users";
import { listUsers } from "@/lib/server/admin/users";
import { SettingsSection } from "@/components/admin/settings-section";
import { listSettings } from "@/lib/server/admin/settings";
import { listInvites } from "@/lib/server/admin/invites";
import { mutedCls } from "@/components/ui/styles";
import { requireAdmin } from "@/lib/server/admin/gate";
import { getAdminDashboard, getHealthInfo } from "@/lib/server/admin/stats";

// Per-request: reads the session and live aggregates. Never indexed.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AdminPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  // Non-admins (and signed-out visitors) get the 404 page before any aggregate is read.
  await requireAdmin();
  const t = await getTranslations("admin");
  const [data, health, invites, users, settings] = await Promise.all([
    getAdminDashboard(),
    getHealthInfo(),
    listInvites(),
    listUsers(),
    listSettings(),
  ]);
  return (
    <main data-wide className="flex flex-col gap-4">
      <div>
        <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
        <p className={mutedCls}>{t("subtitle")}</p>
      </div>
      <SettingsSection settings={settings.ok ? settings.data.settings : []} changes={settings.ok ? settings.data.changes : []} />
      <InvitesSection entries={invites.ok ? invites.data : []} />
      <UsersSection entries={users.ok ? users.data : []} />
      <AdminDashboard data={data} health={health} />
    </main>
  );
}
