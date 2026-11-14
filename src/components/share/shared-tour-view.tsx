import { getTranslations } from "next-intl/server";
import { tourTitle } from "@/components/tour/format";
import { TourResultView } from "@/components/tour/tour-result";
import { mutedCls } from "@/components/ui/styles";
import type { SharedTour } from "@/lib/server/tour/shared";
import { resultFitsInput } from "@/lib/tour/ui";
import { tourView } from "@/lib/tour/view";

/**
 * Public page of a standalone city tour link (city-tour 9.3): the stored snapshot, read-only, in the owner's language.
 * Stop info loads by token; directions and the forecast need a session and are not shown.
 */
export async function SharedTourView({ shared, token, mapStyleUrl }: { shared: SharedTour; token: string; mapStyleUrl: string | null }) {
  const t = await getTranslations("tours");
  const ts = await getTranslations("shared");
  const { tour } = shared;
  const view = tour.outdated ? { stopTimes: null, byMin: null } : tourView(tour.input, tour.result);
  const title = tourTitle(t, tour.title, tour.input.city?.name ?? null, tour.input.places[0]?.name ?? null);
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6" data-testid="shared-tour">
      <div className="flex flex-col gap-1">
        <p className={`text-sm ${mutedCls}`}>{ts("tourBanner")}</p>
        <h1 className="break-words text-3xl font-bold sm:text-4xl">{title}</h1>
      </div>
      {/* A result saved before the input changed may name points that are gone: shown only while it still fits. */}
      {!tour.result || !resultFitsInput(tour.input, tour.result) ? (
        <p className={mutedCls}>{t("notComputed")}</p>
      ) : (
        <TourResultView
          input={tour.input}
          result={tour.result}
          stopTimes={view.stopTimes}
          byMin={view.byMin}
          mapStyleUrl={mapStyleUrl}
          outdated={tour.outdated}
          tourId={tour.id}
          title={title}
          shareToken={token}
        />
      )}
      <p className={`text-sm ${mutedCls}`}>{ts("footer")}</p>
    </div>
  );
}
