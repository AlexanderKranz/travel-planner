import { getTranslations } from "next-intl/server";
import { ErrorBanner } from "@/components/ui/error-banner";
import { PdfButton } from "@/components/pdf/pdf-button";
import { cardCls, mutedCls } from "@/components/ui/styles";
import { MAX_LINKS_PER_TRIP } from "@/lib/domain/share";
import { listShareLinks } from "@/lib/server/shares";
import { PeopleBox } from "@/components/sharing/people-box";
import { ShareCreate } from "./share-create";
import { ShareLinkRow } from "./share-link-row";

/** Owner block: PDF download, create form, list of links. */
export async function SharePanel({
  tripId,
  hasPlan,
  isDemo,
  isAdmin = false,
  owner = true,
  tourEndpointsVisible = false,
  hasTours = false,
}: {
  tripId: string;
  hasPlan: boolean;
  isDemo: boolean;
  isAdmin?: boolean;
  /** False for a grantee: PDF only, no people box, no links (spec sharing 4.3). */
  owner?: boolean;
  /** A city tour on a day of the trip starts or ends at an address (Geoapify, no OSM place): links show it (city-tour 10). */
  tourEndpointsVisible?: boolean;
  /** The trip has city tours: the PDF offers "Ortsinfos aufnehmen" (city-tour-stop-info 6). */
  hasTours?: boolean;
}) {
  const t = await getTranslations("share");
  const tStop = await getTranslations("tours.stopInfo");
  const stopInfoLabel = hasTours ? tStop("pdfInclude") : undefined;
  if (!owner) {
    if (!hasPlan) return null;
    return (
      <section aria-labelledby="share-title" className={`${cardCls} flex min-w-0 flex-col gap-3`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="share-title" className="text-xl font-bold">
            {t("pdfTitle")}
          </h2>
          <PdfButton href={`/api/trips/${tripId}/pdf`} label={t("pdf")} busyLabel={t("pdfBusy")} errorText={t("pdfFailed")} stopInfoLabel={stopInfoLabel} />
        </div>
        <p className={`text-sm ${mutedCls}`}>{t("pdfHint")}</p>
      </section>
    );
  }
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
          <PdfButton href={`/api/trips/${tripId}/pdf`} label={t("pdf")} busyLabel={t("pdfBusy")} errorText={t("pdfFailed")} stopInfoLabel={stopInfoLabel} />
        )}
      </div>
      {hasPlan && <p className={`-mt-2 text-sm ${mutedCls}`}>{t("pdfHint")}</p>}
      <PeopleBox resource="trip" resourceId={tripId} isDemo={isDemo} isAdmin={isAdmin} />
      <h3 className="border-t border-line pt-4 text-base font-semibold">{t("linksTitle")}</h3>
      {tourEndpointsVisible && (
        <p role="note" className="rounded-md border border-line-strong px-3 py-2 text-sm" data-tour-endpoints-visible>
          {t("tourEndpointsVisible")}
        </p>
      )}
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
