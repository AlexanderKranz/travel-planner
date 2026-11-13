import { describe, expect, it } from "vitest";
import { buildGpx, gpxFileName } from "./gpx";
import { encodePolyline } from "./polyline";

describe("buildGpx", () => {
  it("writes a waypoint per stop and a track segment per leg with a line", () => {
    const leg1 = encodePolyline([[48.2085, 16.3731], [48.2075, 16.37], [48.2065, 16.3655]]);
    const gpx = buildGpx({
      name: "Wien & <Altstadt>",
      stops: [{ name: "Stephansdom", lat: 48.2085, lon: 16.3731 }, { name: "Hofburg", lat: 48.2065, lon: 16.3655 }],
      legs: [leg1, null],
      creator: "travel-planner",
    });
    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(gpx).toContain('xmlns="http://www.topografix.com/GPX/1/1"');
    expect(gpx).toContain("<name>Wien &amp; &lt;Altstadt&gt;</name>");
    expect(gpx.match(/<wpt /g)).toHaveLength(2);
    expect(gpx.match(/<trkseg>/g)).toHaveLength(1);
    expect(gpx.match(/<trkpt /g)).toHaveLength(3);
    expect(gpx).toContain('<trkpt lat="48.20750" lon="16.37000"/>');
  });

  it("file names are safe", () => {
    expect(gpxFileName("Wien · Schönbrunn & Prater")).toBe("Wien-Schonbrunn-Prater.gpx");
    expect(gpxFileName("···")).toBe("tour.gpx");
  });
});
