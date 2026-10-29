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
      className="rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg"
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
