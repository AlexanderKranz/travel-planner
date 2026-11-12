"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { mutedCls } from "@/components/ui/styles";
import { RouteSketch } from "./route-sketch";

// MapLibre (about 220 kB gz) is only downloaded on tour views, after hydration.
const TourMap = dynamic(() => import("./tour-map"), {
  ssr: false,
  loading: () => <MapLoading />,
});

function MapLoading() {
  const t = useTranslations("tours");
  return <p className={`flex size-full items-center justify-center text-sm ${mutedCls}`}>{t("mapLoading")}</p>;
}

/** The MapLibre worker is shipped as its own file under /public (see scripts/copy-maplibre-worker.mjs). */
export const MAPLIBRE_WORKER_URL = "/vendor/maplibre-gl-worker.mjs";

type Props = {
  /** OpenFreeMap style; null = map disabled (E2E, or by configuration): the panel shows the fallback. */
  styleUrl: string | null;
  legs: { poly: string | null; dashed?: boolean }[];
  points: { lat: number; lon: number; n: number; name: string }[];
  sights: { lat: number; lon: number; name: string }[];
};

/**
 * Map of the tour (spec 8): 4:3 on phones, collapsible. When the style or the tiles fail, it collapses to "Karte nicht
 * verfügbar" and the plain route sketch (no base map), so the tour stays readable without OpenFreeMap.
 */
export function TourMapPanel({ styleUrl, legs, points, sights }: Props) {
  const t = useTranslations("tours");
  const [failed, setFailed] = useState(styleUrl === null);
  const onFail = useCallback(() => setFailed(true), []);
  const sketch = (
    <RouteSketch legs={legs} points={points.map(({ lat, lon, n }) => ({ lat, lon, n }))} label={t("sketch")} className="h-auto w-full" />
  );

  if (failed) {
    return (
      <section aria-label={t("map")} className="flex flex-col gap-2" data-testid="tour-map-unavailable">
        <p role="status" className={`text-sm ${mutedCls}`}>
          {t("mapUnavailable")}
        </p>
        {sketch}
      </section>
    );
  }

  return (
    <details open className="group rounded-[14px] border border-line bg-card">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-sm font-semibold">{t("map")}</summary>
      <div className="aspect-[4/3] w-full overflow-hidden rounded-b-[14px]">
        <TourMap
          styleUrl={styleUrl!}
          workerUrl={MAPLIBRE_WORKER_URL}
          legs={legs}
          points={points}
          sights={sights}
          attribution={t("mapAttribution")}
          onFail={onFail}
        />
      </div>
    </details>
  );
}
