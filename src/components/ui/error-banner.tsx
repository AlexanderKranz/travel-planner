import { useTranslations } from "next-intl";
import type { ActionError } from "@/lib/domain";
import { Link } from "@/i18n/navigation";
import { linkCls } from "./styles";

export function ErrorBanner({ error }: { error: ActionError | null }) {
  const t = useTranslations("errors");
  if (!error) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-red-600 bg-red-50 p-3 text-sm text-red-900 dark:border-red-400 dark:bg-red-950 dark:text-red-100"
    >
      {t(error)}{" "}
      {error === "unauthenticated" && (
        <Link href="/login" className={linkCls}>
          {t("signInAgain")}
        </Link>
      )}
    </div>
  );
}
