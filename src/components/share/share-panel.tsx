import { getTranslations } from "next-intl/server";
import { ErrorBanner } from "@/components/ui/error-banner";
import { PdfButton } from "@/components/pdf/pdf-button";
import { cardCls, mutedCls } from "@/components/ui/styles";
import { MAX_LINKS_PER_TRIP } from "@/lib/domain/share";
import { listShareLinks } from "@/lib/server/shares";
import { ShareCreate } from "./share-create";
import { ShareLinkRow } from "./share-link-row";

/** Owner block: PDF download, create form, list of links. */
export async function SharePanel({ tripId, hasPlan, isDemo }: { tripId: string; hasPlan: boolean; isDemo: boolean }) {
  const t = await getTranslations("share");
  const res = await listShareLinks(tripId);
  const now = Date.now();
  const links = res.ok ? res.data : [];
  const active = links.filter((l) => !l.expiresAt || new Date(l.expiresAt).getTime() > now).length;
  const reason = isDemo ? t("demoDisabled") : !hasPlan ? t("noPlan") : active >= MAX_LINKS_PER_TRIP ? t("limit") : null;
  return (
    <section aria-labelledby="share-title" className={`${cardCls} flex min-w-0 flex-col gap-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="share-title" className="text-xl font-bold">
          {t("title")}
        </h2>
        {hasPlan && (
          <PdfButton href={`/api/trips/${tripId}/pdf`} label={t("pdf")} busyLabel={t("pdfBusy")} errorText={t("pdfFailed")} />
        )}
      </div>
      {hasPlan && <p className={`-mt-2 text-sm ${mutedCls}`}>{t("pdfHint")}</p>}
      <ShareCreate tripId={tripId} disabledReason={reason} />
      {!res.ok && <ErrorBanner error={res.error} />}
      {links.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-base font-semibold">{t("links")}</h3>
          <ul className="flex flex-col gap-2">
            {links.map((l) => (
              <ShareLinkRow key={l.id} link={l} now={now} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
