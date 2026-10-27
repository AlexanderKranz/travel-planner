import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
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
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-neutral-300 dark:border-neutral-700">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2">
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
      <div className="mx-auto w-full max-w-3xl flex-1 px-4 py-6">{children}</div>
    </div>
  );
}
