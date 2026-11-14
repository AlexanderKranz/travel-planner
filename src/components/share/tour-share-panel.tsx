import { getTranslations } from "next-intl/server";
import { PeopleBox } from "@/components/sharing/people-box";
import { ErrorBanner } from "@/components/ui/error-banner";
import { cardCls, mutedCls } from "@/components/ui/styles";
import { MAX_LINKS_PER_TRIP, type ShareLink } from "@/lib/domain/share";
import { listTourShareLinks } from "@/lib/server/shares";
import { ShareCreate } from "./share-create";
import { ShareLinkRow } from "./share-link-row";

/** Request time and the number of links that have not expired yet (kept out of the component body). */
function activeLinks(links: ShareLink[]): { now: number; active: number } {
  const now = Date.now();
  return { now, active: links.filter((l) => !l.expiresAt || new Date(l.expiresAt).getTime() > now).length };
}

/**
 * Owner block of a standalone city tour (city-tour 9.3): people with access (read / write) and public read-only links.
 * A link needs a computed tour; the demo account gets both boxes disabled.
 */
export async function TourSharePanel({ tourId, computed, isDemo, isAdmin }: { tourId: string; computed: boolean; isDemo: boolean; isAdmin: boolean }) {
  const t = await getTranslations("share");
  const tt = await getTranslations("tours.sharing");
  const res = await listTourShareLinks(tourId);
  const links = res.ok ? res.data : [];
  const { now, active } = activeLinks(links);
  const reason = isDemo ? t("demoDisabled") : !computed ? tt("needsResult") : active >= MAX_LINKS_PER_TRIP ? t("limit") : null;
  return (
    <section aria-labelledby="tour-share-title" className={`${cardCls} flex min-w-0 flex-col gap-4`} data-testid="tour-share-panel">
      <h2 id="tour-share-title" className="text-xl font-bold">
        {tt("title")}
      </h2>
      <PeopleBox resource="tour" resourceId={tourId} isDemo={isDemo} isAdmin={isAdmin} />
      <h3 className="border-t border-line pt-4 text-base font-semibold">{t("linksTitle")}</h3>
      <p className={`text-sm ${mutedCls}`}>{tt("linksHint")}</p>
      <ShareCreate tourId={tourId} disabledReason={reason} />
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
