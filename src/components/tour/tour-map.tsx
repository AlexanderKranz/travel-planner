"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibre from "maplibre-gl";
import { useEffect, useRef } from "react";
import { decodePolyline } from "@/lib/tour/polyline";

/**
 * MapLibre GL JS map of a city tour (spec 8 [T13]): OpenFreeMap vector tiles, leg lines (dashed for a per-leg mode
 * override), numbered stop markers and sight dots. Loaded only through `next/dynamic` from `tour-map-panel.tsx`, so no
 * other page downloads MapLibre. Calls `onFail` when the style or tiles cannot be loaded or WebGL is missing; the
 * panel then collapses to "Karte nicht verfügbar" and the route sketch.
 */
export type TourMapProps = {
  styleUrl: string;
  workerUrl: string;
  legs: { poly: string | null; dashed?: boolean }[];
  points: { lat: number; lon: number; n: number; name: string }[];
  sights: { lat: number; lon: number; name: string }[];
  attribution: string;
  onFail: () => void;
};

/** No style and first tiles within this time: treat the map as unavailable. */
const LOAD_TIMEOUT_MS = 15_000;
/** Errors after the first load that collapse the map. */
const LATE_ERRORS = 3;

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export default function TourMap({ styleUrl, workerUrl, legs, points, sights, attribution, onFail }: TourMapProps) {
  const ref = useRef<HTMLDivElement>(null);
  const failRef = useRef(onFail);
  useEffect(() => {
    failRef.current = onFail;
  }, [onFail]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let map: maplibre.Map | null = null;
    let loaded = false;
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      failRef.current();
    };

    const lines = legs.map((l) => {
      try {
        return l.poly ? decodePolyline(l.poly).map(([lat, lon]) => [lon, lat] as [number, number]) : null;
      } catch {
        return null;
      }
    });
    const coords: [number, number][] = [...lines.flatMap((l) => l ?? []), ...points.map((p) => [p.lon, p.lat] as [number, number]), ...sights.map((s) => [s.lon, s.lat] as [number, number])];
    if (coords.length === 0) return;
    const bounds = coords.reduce((b, c) => b.extend(c), new maplibre.LngLatBounds(coords[0], coords[0]));

    try {
      // The version busts the browser cache of the unhashed file in public/vendor when MapLibre is upgraded.
      maplibre.setWorkerUrl(`${workerUrl}?v=${maplibre.getVersion()}`);
      map = new maplibre.Map({
        container: el,
        style: styleUrl,
        bounds,
        fitBoundsOptions: { padding: 40, maxZoom: 17 },
        attributionControl: { compact: true, customAttribution: attribution },
        cooperativeGestures: true,
        dragRotate: false,
        pitchWithRotate: false,
      });
    } catch {
      fail();
      return;
    }
    const timer = setTimeout(() => {
      if (!loaded) fail();
    }, LOAD_TIMEOUT_MS);
    // Before the first load any error means no map. Afterwards one missing tile is tolerated (a pan into a slow area);
    // repeated errors mean OpenFreeMap is gone, and the panel falls back to the sketch.
    let lateErrors = 0;
    map.on("error", () => {
      if (!loaded || ++lateErrors >= LATE_ERRORS) fail();
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      loaded = true;
      if (!map) return;
      const accent = cssVar("--accent", "#b4532a");
      const heading = cssVar("--heading", "#1f3a5f");
      map.addSource("tour-legs", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: lines.flatMap((line, i) =>
            line ? [{ type: "Feature" as const, properties: { dashed: !!legs[i].dashed }, geometry: { type: "LineString" as const, coordinates: line } }] : [],
          ),
        },
      });
      map.addLayer({
        id: "tour-legs-solid",
        type: "line",
        source: "tour-legs",
        filter: ["==", ["get", "dashed"], false],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": accent, "line-width": 4 },
      });
      map.addLayer({
        id: "tour-legs-dashed",
        type: "line",
        source: "tour-legs",
        filter: ["==", ["get", "dashed"], true],
        layout: { "line-join": "round" },
        paint: { "line-color": accent, "line-width": 4, "line-dasharray": [2, 1.5] },
      });
      map.addSource("tour-sights", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: sights.map((s) => ({ type: "Feature" as const, properties: { name: s.name }, geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] } })),
        },
      });
      map.addLayer({
        id: "tour-sights",
        type: "circle",
        source: "tour-sights",
        paint: { "circle-radius": 5, "circle-color": "#ffffff", "circle-stroke-color": heading, "circle-stroke-width": 2 },
      });
      for (const p of points) {
        const m = document.createElement("div");
        m.className = "flex size-7 items-center justify-center rounded-full border-2 border-white bg-heading text-xs font-bold text-page shadow";
        m.textContent = String(p.n);
        m.title = p.name;
        m.setAttribute("aria-hidden", "true");
        new maplibre.Marker({ element: m }).setLngLat([p.lon, p.lat]).addTo(map);
      }
    });

    return () => {
      clearTimeout(timer);
      map?.remove();
    };
    // The panel remounts the map (key) when the tour changes; props are read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={ref} className="size-full" />;
}
