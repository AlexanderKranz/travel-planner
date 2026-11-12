import type { TourPoint } from "@/lib/domain/tour";

/** Wien fixture points (rounded public coordinates). Test helper only. */
export const WIEN_CITY: TourPoint = { key: "geo:2761369", name: "Wien", lat: 48.20849, lon: 16.37208, source: "geonames" };
export const STEPHANSDOM: TourPoint = { key: "osm:w1", name: "Stephansdom", lat: 48.20853, lon: 16.37319, source: "osm" };
export const HOFBURG: TourPoint = { key: "osm:w2", name: "Hofburg", lat: 48.20652, lon: 16.36564, source: "osm" };
export const NASCHMARKT: TourPoint = { key: "osm:w3", name: "Naschmarkt", lat: 48.19864, lon: 16.36302, source: "osm" };
export const BELVEDERE: TourPoint = { key: "osm:w4", name: "Belvedere", lat: 48.19152, lon: 16.38016, source: "osm" };
export const RIESENRAD: TourPoint = { key: "osm:n5", name: "Riesenrad", lat: 48.21666, lon: 16.39598, source: "osm" };
