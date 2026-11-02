"use client";

import { useTranslations } from "next-intl";
import { focusCls, mutedCls } from "@/components/ui/styles";
import { Link, usePathname } from "@/i18n/navigation";

/** Small link below the app content. Carries the current path as `?from=`; hidden on the feedback page itself. */
export function FeedbackFooterLink() {
  const t = useTranslations("feedback.entry");
  const pathname = usePathname();
  if (pathname.startsWith("/app/feedback")) return null;
  return (
    <footer data-no-print className="border-t border-line px-4 py-3 text-center">
      <Link
        href={{ pathname: "/app/feedback", query: { from: pathname } }}
        className={`${mutedCls} inline-flex min-h-11 items-center rounded-md px-2 text-sm underline underline-offset-2 hover:text-heading ${focusCls}`}
      >
        {t("footer")}
      </Link>
    </footer>
  );
}
