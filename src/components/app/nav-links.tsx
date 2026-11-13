"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

const ITEMS = [
  { href: "/app", key: "trips" },
  { href: "/app/tours", key: "tours" },
  { href: "/app/groups", key: "groups" },
  { href: "/app/purposes", key: "purposes" },
  { href: "/settings", key: "settings" },
] as const;

export function NavLinks({ isAdmin = false, showFeedback = false }: { isAdmin?: boolean; showFeedback?: boolean }) {
  const t = useTranslations("nav");
  const tf = useTranslations("feedback.entry");
  const pathname = usePathname();
  const onFeedback = pathname === "/app/feedback";
  return (
    <nav aria-label={t("label")}>
      <ul className="flex flex-wrap gap-x-1 sm:gap-x-3">
        {[...ITEMS, ...(isAdmin ? ([{ href: "/app/admin", key: "admin" }] as const) : [])].map(({ href, key }) => {
          // "Reisen" is the dashboard at /app and also owns every page below /app/trips.
          const current =
            key === "trips"
              ? pathname === "/app" || pathname === "/app/trips" || pathname.startsWith("/app/trips/")
              : pathname === href || pathname.startsWith(`${href}/`);
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
        {showFeedback && (
          // Pill instead of a tab: an action, not a section. Carries the current path as `?from=` (spec feedback [D12]).
          // On the feedback page it is a plain marker, so a click cannot drop the page's own `?from=`.
          <li className="flex items-center">
            {onFeedback ? (
              <span aria-current="page" className="inline-flex min-h-11 items-center px-2">
                <span className="rounded-full border border-nav-underline bg-white/10 px-3 py-1 text-sm font-medium text-feature-accent">
                  {tf("nav")}
                </span>
              </span>
            ) : (
              <Link
                href={{ pathname: "/app/feedback", query: { from: pathname } }}
                title={tf("navTitle")}
                className="group inline-flex min-h-11 items-center px-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-feature-accent"
              >
                <span className="rounded-full border border-header-muted/50 px-3 py-1 text-sm font-medium text-feature-accent group-hover:border-header-fg">
                  {tf("nav")}
                </span>
              </Link>
            )}
          </li>
        )}
      </ul>
    </nav>
  );
}
