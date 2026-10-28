import { useTranslations } from "next-intl";
import { ErrorBanner } from "@/components/ui/error-banner";
import type { ActionError } from "@/lib/domain";

/** Item-specific wording for limit_reached (the shared text talks about trips). */
export function ItemError({ error }: { error: ActionError | null }) {
  const t = useTranslations("items");
  if (error === "limit_reached") {
    return (
      <div
        role="alert"
        className="rounded-md border border-red-600 bg-red-50 p-3 text-sm text-red-900 dark:border-red-400 dark:bg-red-950 dark:text-red-100"
      >
        {t("limit")}
      </div>
    );
  }
  return <ErrorBanner error={error} />;
}
