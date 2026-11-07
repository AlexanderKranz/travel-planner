import { getTranslations } from "next-intl/server";
import { LoadNotice } from "./load-notice";

/** Shown when JavaScript is off, or after a few seconds when the app scripts did not load: forms stay disabled without them. */
export async function NoscriptNotice() {
  const t = await getTranslations("noscript");
  return <LoadNotice text={t("message")} />;
}
