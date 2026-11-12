"use client";

import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";
import { linkCls, mutedCls } from "@/components/ui/styles";
import type { TourMode } from "@/lib/domain/tour";
import { GOOGLE_MAX_WAYPOINTS, googleMapsLinks } from "@/lib/tour/links";

/**
 * Google documents 3 waypoints for a mobile browser without the Maps app (9 in the app and on desktop). The app
 * cannot be detected, and Google silently drops extra waypoints, so touch devices get links with at most 3 waypoints
 * (more links for a long tour, but none loses a stop). Desktop keeps 9.
 */
export const MOBILE_MAX_WAYPOINTS = 3;

const COARSE = "(pointer: coarse)";
const subscribe = (cb: () => void) => {
  const mq = window.matchMedia(COARSE);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};

export function GoogleLinks({ points, mode }: { points: { lat: number; lon: number }[]; mode: TourMode }) {
  const t = useTranslations("tours");
  const coarse = useSyncExternalStore(subscribe, () => window.matchMedia(COARSE).matches, () => false);
  const links = googleMapsLinks(points, mode, coarse ? MOBILE_MAX_WAYPOINTS : GOOGLE_MAX_WAYPOINTS);
  if (links.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col">
        {links.map((href, i) => (
          <li key={href}>
            <a href={href} target="_blank" rel="noopener noreferrer" className={`${linkCls} inline-flex min-h-11 items-center`}>
              {links.length === 1 ? t("openGoogle") : t("openGooglePart", { n: i + 1, count: links.length })}
            </a>
          </li>
        ))}
      </ul>
      <p className={`text-sm ${mutedCls}`}>{t("openGoogleNote")}</p>
    </div>
  );
}
