import { getTranslations } from "next-intl/server";

/** Shown only when JavaScript is off or failed to load: forms stay disabled without it. */
export async function NoscriptNotice() {
  const t = await getTranslations("noscript");
  return (
    <noscript>
      <p className="rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg">{t("message")}</p>
    </noscript>
  );
}
