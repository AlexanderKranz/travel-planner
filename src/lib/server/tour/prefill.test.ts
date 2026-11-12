import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../session", () => ({ getUserSession: vi.fn() }));
vi.mock("../trips", () => ({ getTrip: vi.fn() }));
vi.mock("../plan-store", () => ({ getPlanRow: vi.fn(), getVersion: vi.fn() }));
vi.mock("./places", () => ({ catOf: (c: string) => (c.split("=").pop() ?? c).slice(0, 40) }));
vi.mock("./point-ref", () => ({ signPointRef: () => "ref" }));

import { dayPlaces, tourKeyOfPlanRef } from "./prefill";

const place = (name: string, lat: number, lon: number) => ({
  name,
  category: "amenity=place_of_worship",
  lat,
  lon,
  distanceKm: 1,
  osmUrl: "https://www.openstreetmap.org/node/1",
  source: "osm" as const,
  fetchedAt: "2026-11-01T00:00:00Z",
});

describe("tour prefill", () => {
  it("maps plan keys to tour keys", () => {
    expect(tourKeyOfPlanRef("node/123")).toBe("osm:n123");
    expect(tourKeyOfPlanRef("way/4")).toBe("osm:w4");
    expect(tourKeyOfPlanRef("relation/5")).toBe("osm:r5");
    expect(tourKeyOfPlanRef("p1")).toBeNull();
  });

  it("takes the day's refs in order, once each, with coordinates and category", () => {
    const plan = {
      days: [
        { n: 1, date: null, title: "A", stops: [{ place: "Passau", acts: [{ kind: "see" as const, text: "x", ref: "node/1" }] }] },
        {
          n: 2,
          date: null,
          title: "B",
          stops: [
            {
              place: "Passau",
              acts: [
                { kind: "see" as const, text: "Dom", ref: "way/2" },
                { kind: "food" as const, text: "Lunch" },
                { kind: "see" as const, text: "Dom again", ref: "way/2" },
                { kind: "see" as const, text: "Missing", ref: "node/404" },
                { kind: "see" as const, text: "Veste", ref: "node/3" },
              ],
            },
          ],
        },
      ],
      places: {
        "node/1": place("Rathaus", 48.57, 13.46),
        "way/2": place("Dom St. Stephan", 48.5741, 13.4648),
        "node/3": place("Veste Oberhaus", 48.5775, 13.4718),
      },
    };
    expect(dayPlaces(plan, 2)).toEqual([
      { key: "osm:w2", name: "Dom St. Stephan", lat: 48.5741, lon: 13.4648, cat: "place_of_worship" },
      { key: "osm:n3", name: "Veste Oberhaus", lat: 48.5775, lon: 13.4718, cat: "place_of_worship" },
    ]);
    expect(dayPlaces(plan, 3)).toEqual([]);
  });
});
