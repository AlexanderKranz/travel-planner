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
        className="rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg"
      >
        {t("limit")}
      </div>
    );
  }
  return <ErrorBanner error={error} />;
}
