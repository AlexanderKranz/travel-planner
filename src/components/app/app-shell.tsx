import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getProfile } from "@/lib/server/profile";
import { signOut } from "@/lib/server/auth/actions";
import { btnSecondary, focusCls } from "@/components/ui/styles";
import { NavLinks } from "./nav-links";

export async function AppShell({
  locale,
  children,
}: {
  locale: string;
  children: React.ReactNode;
}) {
  const t = await getTranslations("nav");
  const profile = await getProfile();
  const isDemo = profile.ok && profile.data.isDemo;
  return (
    <div className="flex min-h-screen flex-col">
      {isDemo && (
        <div
          role="status"
          aria-label={t("demoLabel")}
          className="border-b border-amber-600 bg-amber-100 px-4 py-2 text-center text-sm text-amber-950 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100"
        >
          {t("demoBanner")}
        </div>
      )}
      <header className="border-b border-neutral-300 dark:border-neutral-700">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 sm:px-6 lg:px-8">
          <Link href="/app" className={`rounded-md py-2 text-lg font-bold ${focusCls}`}>
            {t("appName")}
          </Link>
          <form action={signOut.bind(null, locale)}>
            <button type="submit" className={btnSecondary}>
              {t("signOut")}
            </button>
          </form>
          <div className="w-full sm:w-auto sm:flex-1 sm:order-none">
            <NavLinks />
          </div>
        </div>
      </header>
      {/* Wide container (spec timed-items [D16]); pages stay at reading width unless their <main> sets data-wide. */}
      <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8 [&>main:not([data-wide])]:mx-auto [&>main:not([data-wide])]:max-w-3xl">
        {children}
      </div>
    </div>
  );
}
