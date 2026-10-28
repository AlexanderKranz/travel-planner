"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

const ITEMS = [
  { href: "/app/trips", key: "trips" },
  { href: "/app/groups", key: "groups" },
  { href: "/app/purposes", key: "purposes" },
  { href: "/settings", key: "settings" },
] as const;

export function NavLinks({ isAdmin = false }: { isAdmin?: boolean }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  return (
    <nav aria-label={t("label")}>
      <ul className="flex flex-wrap gap-x-1 sm:gap-x-3">
        {[...ITEMS, ...(isAdmin ? ([{ href: "/app/admin", key: "admin" }] as const) : [])].map(({ href, key }) => {
          const current = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={key}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className={`inline-flex min-h-11 items-center border-b-2 px-3 text-[0.9375rem] font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-feature-accent ${
                  current
                    ? "border-nav-underline text-header-fg"
                    : "border-transparent text-header-muted hover:text-header-fg"
                }`}
              >
                {t(key)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
