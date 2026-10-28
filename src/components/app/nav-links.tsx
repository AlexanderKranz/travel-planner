"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { focusCls } from "@/components/ui/styles";

const ITEMS = [
  { href: "/app/trips", key: "trips" },
  { href: "/app/groups", key: "groups" },
  { href: "/app/purposes", key: "purposes" },
  { href: "/settings", key: "settings" },
] as const;

export function NavLinks() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  return (
    <nav aria-label={t("label")}>
      <ul className="flex flex-wrap gap-1">
        {ITEMS.map(({ href, key }) => {
          const current = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={key}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-md px-3 text-sm ${focusCls} ${
                  current
                    ? "bg-neutral-200 font-semibold dark:bg-neutral-800"
                    : "hover:bg-neutral-100 dark:hover:bg-neutral-900"
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
