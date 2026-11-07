import { getTranslations } from "next-intl/server";
import { LoadNotice } from "./load-notice";

/** Delay before the notice shows when the page has not hydrated: a normal load never sees it. */
const STALL_MS = 4000;

/**
 * Shown when JavaScript is off, or after a few seconds when the app scripts did not load: forms stay disabled without
 * them. The inline script runs while the HTML is parsed, independent of the app chunks; it only adds a style, so the
 * markup React hydrates is untouched. Once hydrated, `LoadNotice` renders nothing and the style has no target.
 */
export async function NoscriptNotice() {
  const t = await getTranslations("noscript");
  const reveal = `setTimeout(function(){var s=document.createElement("style");s.textContent=".load-notice{display:block}";document.head.appendChild(s)},${STALL_MS})`;
  return (
    <>
      <LoadNotice text={t("message")} />
      <script dangerouslySetInnerHTML={{ __html: reveal }} />
    </>
  );
}
