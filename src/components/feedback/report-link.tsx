"use client";

import { useTranslations } from "next-intl";
import { useCanReportFeedback } from "./entry-context";
import { linkCls } from "@/components/ui/styles";
import { Link, usePathname } from "@/i18n/navigation";

/** "Report this problem" on the error view: Bug preselected, current page passed along. Nothing for the demo account. */
export function ReportProblemLink() {
  const t = useTranslations("feedback.entry");
  const can = useCanReportFeedback();
  const pathname = usePathname();
  if (!can) return null;
  return (
    <Link
      href={{ pathname: "/app/feedback", query: { kind: "bug", from: pathname } }}
      className={`${linkCls} inline-flex min-h-11 items-center`}
    >
      {t("reportProblem")}
    </Link>
  );
}
