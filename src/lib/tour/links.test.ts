import { describe, expect, it } from "vitest";
import { googleMapsLinks } from "./links";

const pts = (n: number) => Array.from({ length: n }, (_, i) => ({ lat: 48.2 + i / 1000, lon: 16.37 }));
const params = (url: string) => new URL(url).searchParams;

describe("googleMapsLinks", () => {
  it("builds one link with origin, destination, waypoints and travel mode", () => {
    const [url, ...rest] = googleMapsLinks(pts(4), "foot");
    expect(rest).toEqual([]);
    expect(url.startsWith("https://www.google.com/maps/dir/?api=1&")).toBe(true);
    const p = params(url);
    expect(p.get("origin")).toBe("48.20000,16.37000");
    expect(p.get("destination")).toBe("48.20300,16.37000");
    expect(p.get("waypoints")).toBe("48.20100,16.37000|48.20200,16.37000");
    expect(p.get("travelmode")).toBe("walking");
  });

  it("maps modes", () => {
    const mode = (m: "foot" | "wheelchair" | "cycling" | "ebike" | "car") => params(googleMapsLinks(pts(2), m)[0]).get("travelmode");
    expect([mode("foot"), mode("wheelchair"), mode("cycling"), mode("ebike"), mode("car")]).toEqual([
      "walking",
      "walking",
      "bicycling",
      "bicycling",
      "driving",
    ]);
    expect(params(googleMapsLinks(pts(2), "car")[0]).has("waypoints")).toBe(false);
  });

  it("keeps 9 waypoints in one link and splits beyond", () => {
    expect(googleMapsLinks(pts(11), "foot")).toHaveLength(1);
    const two = googleMapsLinks(pts(13), "foot");
    expect(two).toHaveLength(2);
    expect(params(two[0]).get("waypoints")!.split("|")).toHaveLength(9);
    // The second link starts where the first ended.
    expect(params(two[1]).get("origin")).toBe(params(two[0]).get("destination"));
    expect(params(two[1]).get("destination")).toBe("48.21200,16.37000");
    expect(googleMapsLinks(pts(1), "foot")).toEqual([]);
  });

  it("honours a smaller waypoint limit (mobile browser)", () => {
    const links = googleMapsLinks(pts(9), "foot", 3);
    expect(links).toHaveLength(2);
    expect(params(links[0]).get("waypoints")!.split("|")).toHaveLength(3);
    expect(params(links[1]).get("destination")).toBe("48.20800,16.37000");
  });
});
