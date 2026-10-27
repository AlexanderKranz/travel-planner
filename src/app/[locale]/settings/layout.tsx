import { setRequestLocale } from "next-intl/server";
import { redirect } from "@/i18n/navigation";
import { getUserSession } from "@/lib/server/session";
import { AppShell } from "@/components/app/app-shell";

// Per-request: reads the session cookie.
export const dynamic = "force-dynamic";

export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  // Second layer behind the middleware.
  if (!(await getUserSession())) redirect({ href: "/login", locale });
  return <AppShell locale={locale}>{children}</AppShell>;
}
