import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ fetchJson: vi.fn() }));
vi.mock("./http", async (orig) => ({ ...(await orig<typeof import("./http")>()), fetchJson: h.fetchJson }));

import { encodePolyline, type LatLon } from "@/lib/tour/polyline";
import { fetchPlan, pickConnection, planUrl, TRANSITOUS_USER_AGENT } from "./transitous";

/** Recorded-style answers (shape of the 2026-11-13 spike: Wien Stephansdom → Schönbrunn, weekday 10:00 local). */
const geo = (pts: LatLon[]) => ({ points: encodePolyline(pts, 6), precision: 6 });
const STEPHANSDOM: LatLon = [48.20853, 16.37319];
const STEPHANSPLATZ: LatLon = [48.2081, 16.3725];
const KARLSPLATZ: LatLon = [48.2002, 16.3699];
const SCHOENBRUNN_U: LatLon = [48.1865, 16.3192];
const SCHLOSS: LatLon = [48.18486, 16.31224];
const leg = (mode: string, from: string, to: string, s: string, e: string, pts: LatLon[], extra: object = {}) => ({
  mode,
  from: { name: from },
  to: { name: to },
  startTime: s,
  endTime: e,
  legGeometry: geo(pts),
  ...extra,
});
const wien = {
  itineraries: [
    {
      startTime: "2026-11-17T08:55:00Z", // departs before the requested 09:00Z: not taken
      endTime: "2026-11-17T09:25:00Z",
      legs: [leg("SUBWAY", "START", "Wien Schönbrunn", "2026-11-17T08:55:00Z", "2026-11-17T09:25:00Z", [STEPHANSDOM, SCHLOSS])],
    },
    {
      startTime: "2026-11-17T09:02:00Z",
      endTime: "2026-11-17T09:34:00Z",
      legs: [
        leg("WALK", "START", "Wien Stephansplatz", "2026-11-17T09:02:00Z", "2026-11-17T09:07:00Z", [STEPHANSDOM, STEPHANSPLATZ]),
        leg("SUBWAY", "Wien Stephansplatz", "Wien Karlsplatz", "2026-11-17T09:07:00Z", "2026-11-17T09:09:00Z", [STEPHANSPLATZ, KARLSPLATZ], {
          displayName: "U1", headsign: "Wien Oberlaa", agencyName: "Wiener Linien GmbH & Co KG", intermediateStops: [],
        }),
        leg("WALK", "Wien Karlsplatz", "Wien Karlsplatz", "2026-11-17T09:09:00Z", "2026-11-17T09:11:00Z", [KARLSPLATZ, KARLSPLATZ]),
        leg("SUBWAY", "Wien Karlsplatz", "Wien Schönbrunn", "2026-11-17T09:12:00Z", "2026-11-17T09:21:00Z", [KARLSPLATZ, SCHOENBRUNN_U], {
          routeShortName: "U4", headsign: "Wien Hütteldorf", agencyName: "Wiener Linien GmbH & Co KG", intermediateStops: [1, 2, 3, 4],
        }),
        leg("WALK", "Wien Schönbrunn", "END", "2026-11-17T09:21:00Z", "2026-11-17T09:34:00Z", [SCHOENBRUNN_U, SCHLOSS]),
      ],
    },
  ],
  direct: [{ startTime: "2026-11-17T09:00:00Z", endTime: "2026-11-17T10:05:00Z", legs: [leg("WALK", "START", "END", "2026-11-17T09:00:00Z", "2026-11-17T10:05:00Z", [STEPHANSDOM, SCHLOSS])] }],
};
const DEPART = Date.UTC(2026, 10, 17, 9, 0);

describe("pickConnection", () => {
  it("takes the first itinerary departing at or after the leg's departure; minutes include the wait", () => {
    const a = pickConnection(wien, DEPART, "Europe/Vienna");
    expect(a.kind).toBe("ok");
    if (a.kind !== "ok") return;
    expect(a.min).toBe(34); // arrival 09:34Z minus requested 09:00Z
    expect(a.parts.map((p) => [p.m, p.line ?? "", p.dep, p.arr])).toEqual([
      ["walk", "", "10:02", "10:07"],
      ["SUBWAY", "U1", "10:07", "10:09"],
      ["walk", "", "10:09", "10:11"],
      ["SUBWAY", "U4", "10:12", "10:21"],
      ["walk", "", "10:21", "10:34"],
    ]);
    expect(a.parts[1]).toMatchObject({ head: "Wien Oberlaa", agency: "Wiener Linien GmbH & Co KG", from: "Wien Stephansplatz", stops: 1 });
    expect(a.parts[3].stops).toBe(5);
    expect(a.km).toBeGreaterThan(3);
    expect(a.poly.length).toBeGreaterThan(0);
  });

  it("keeps walking when the direct walk is not slower (Passau / Frankfurt cases)", () => {
    const body = {
      itineraries: [{ startTime: "2026-11-17T09:05:00Z", endTime: "2026-11-17T09:18:00Z", legs: [leg("TRAM", "A", "B", "2026-11-17T09:05:00Z", "2026-11-17T09:18:00Z", [STEPHANSDOM, KARLSPLATZ])] }],
      direct: [{ startTime: "2026-11-17T09:00:00Z", endTime: "2026-11-17T09:18:00Z", legs: [leg("WALK", "A", "B", "2026-11-17T09:00:00Z", "2026-11-17T09:18:00Z", [STEPHANSDOM, KARLSPLATZ])] }],
    };
    expect(pickConnection(body, DEPART, "Europe/Vienna")).toMatchObject({ kind: "walk_not_slower", min: 18 });
  });

  it("no itinerary after the departure and no walk → no_connection; a bad shape throws", () => {
    expect(pickConnection({ itineraries: [wien.itineraries[0]] }, DEPART, "Europe/Vienna")).toEqual({ kind: "no_connection" });
    expect(() => pickConnection({ nope: 1 }, DEPART, "Europe/Vienna")).toThrow();
  });
});

describe("fetchPlan", () => {
  beforeEach(() => h.fetchJson.mockReset());
  it("sends the coordinates, the local departure with its offset and the User-Agent with the repo URL", async () => {
    h.fetchJson.mockResolvedValue({ status: 200, latencyMs: 210, body: wien });
    const r = await fetchPlan({ lat: 48.208531, lon: 16.373191 }, { lat: 48.18486, lon: 16.31224 }, { utcMs: DEPART, iso: "2026-11-17T10:00:00+01:00" }, "Europe/Vienna");
    const [url, opts] = h.fetchJson.mock.calls[0];
    const q = new URL(url).searchParams;
    expect(url.startsWith("https://api.transitous.org/api/v6/plan?")).toBe(true);
    expect([q.get("fromPlace"), q.get("toPlace"), q.get("time")]).toEqual(["48.20853,16.37319", "48.18486,16.31224", "2026-11-17T10:00:00+01:00"]);
    expect(opts.headers["User-Agent"]).toBe(TRANSITOUS_USER_AGENT);
    expect(TRANSITOUS_USER_AGENT).toContain("github.com/AlexanderKranz/travel-planner");
    expect(r.answer.kind).toBe("ok");
    expect(planUrl({ lat: 1, lon: 2 }, { lat: 3, lon: 4 }, "x")).toContain("time=x");
  });
});
