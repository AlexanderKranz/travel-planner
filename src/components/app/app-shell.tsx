import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { getProfileOnce } from "@/lib/server/request-reads";
import { signOut } from "@/lib/server/auth/actions";
import { btnGhost } from "@/components/ui/styles";
import { NavLinks } from "./nav-links";

export async function AppShell({
  locale,
  children,
}: {
  locale: string;
  children: React.ReactNode;
}) {
  const t = await getTranslations("nav");
  const profile = await getProfileOnce();
  const isDemo = profile.ok && profile.data.isDemo;
  const isAdmin = profile.ok && profile.data.role === "admin";
  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-card focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-heading focus:outline-2 focus:outline-offset-2 focus:outline-focus"
      >
        {t("skip")}
      </a>
      {isDemo && (
        <div
          role="status"
          aria-label={t("demoLabel")}
          className="border-b border-warn-line bg-warn-bg px-4 py-2 text-center text-sm text-warn-fg"
        >
          {t("demoBanner")}
        </div>
      )}
      <header data-no-print className="bg-header text-header-fg">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-2 sm:px-6 lg:px-8">
          <Link
            href="/app"
            className="rounded-md py-2 font-serif text-xl font-bold tracking-wide text-header-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-feature-accent"
          >
            {t("appName")}
          </Link>
          <form action={signOut.bind(null, locale)} className="sm:order-3">
            <button
              type="submit"
              className={`${btnGhost} text-header-muted hover:bg-white/10 hover:text-header-fg focus-visible:outline-feature-accent`}
            >
              {t("signOut")}
            </button>
          </form>
          <div className="w-full sm:order-2 sm:w-auto sm:flex-1">
            <NavLinks isAdmin={isAdmin} />
          </div>
        </div>
      </header>
      {/* Wide container (spec timed-items [D16]); pages stay at reading width unless their <main> sets data-wide. */}
      <div id="content" tabIndex={-1} className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 focus:outline-none sm:px-6 lg:px-8 [&>main:not([data-wide])]:mx-auto [&>main:not([data-wide])]:max-w-3xl">
        {children}
      </div>
    </div>
  );
}
