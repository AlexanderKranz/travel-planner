import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Trip } from "@/lib/domain/trip";
import { normalizeFids, normalizeRoutes, type RouteStat } from "@/lib/integrations/aerodatabox-normalize";

vi.mock("server-only", () => ({}));

const fx = (n: string) => JSON.parse(readFileSync(`${__dirname}/../../integrations/__fixtures__/aerodatabox/${n}`, "utf8"));
const fra = normalizeFids(fx("fids-departures-FRA-2027-03-06.json"));
const agp = normalizeFids(fx("fids-departures-AGP-2026-03-18-past.json"));
const routes: RouteStat[] = normalizeRoutes(fx("routes-daily-FRA-2027-03-14.json"));
routes.push({ to: "AGP", perDay: 1.71, operators: [{ iata: "LH", name: "Lufthansa" }] });

const calls: string[] = [];
const cacheState = { refuse: false, failFids: false };
vi.mock("@/lib/integrations/aerodatabox", () => ({
  UNITS: { routes: 6, fids: 2, dates: 2 },
  aeroDataBoxEnabled: () => process.env.AERODATABOX_API_KEY === "x",
  fetchRoutesDaily: async (a: string, d: string) => (calls.push(`R ${a} ${d}`), { data: routes, status: 200, latencyMs: 1, units: 6 }),
  fetchDepartures: async (a: string, d: string, w: string) => (calls.push(`F ${a} ${d} ${w}`), { data: a === "FRA" ? fra : agp, status: 200, latencyMs: 1, units: 2 }),
  fetchFlightDates: async (n: string, m: string) => (calls.push(`N ${n} ${m}`), { data: ["2027-03-06", "2027-03-13"], status: 200, latencyMs: 1, units: 2 }),
}));
vi.mock("../api-cache", async (orig) => {
  const real = await orig<typeof import("../api-cache")>();
  return {
    ...real,
    cached: async (o: { endpoint: string; schema: { parse: (x: unknown) => unknown }; fetcher: () => Promise<{ data: unknown }> }) => {
      if (cacheState.refuse) return { ok: false, error: "quota_exhausted" };
      if (cacheState.failFids && o.endpoint === "fids_departures") return { ok: false, error: "provider_error" };
      const r = await o.fetcher();
      return { ok: true, data: o.schema.parse(r.data), fetchedAt: "2026-10-28T08:00:00.000Z", stale: false, cache: "miss" };
    },
  };
});

import { getFlightsFacts } from "./flights";

const ctx = { userId: "u", locale: "de" as const, today: "2026-10-28" };
const trip = (over: Partial<Trip> = {}): Trip => ({
  id: "t", lengthDays: 5, groupId: null, purposeId: null, wantsFlights: true, originAirports: [], createdAt: "", updatedAt: "",
  destination: { kind: "region", name: "Costa del Sol", placeName: "Marbella", geoId: 1, countryCode: "ES", admin1: null, lat: 36.51543, lon: -4.88583, timezone: null, radiusKm: 40 },
  timing: { kind: "date", startDate: "2027-03-06" },
  ...over,
});
const run = (t: Trip, home: string[] = ["FRA"], budgetMs?: number) => getFlightsFacts(t, { homeAirports: home, purpose: null, ctx, budgetMs });

beforeEach(() => {
  calls.length = 0;
  cacheState.refuse = false;
  cacheState.failFids = false;
  process.env.AERODATABOX_API_KEY = "x";
});

describe("getFlightsFacts", () => {
  it("disabled without key, zero calls", async () => {
    delete process.env.AERODATABOX_API_KEY;
    expect(await run(trip())).toEqual({ status: "unavailable", reason: "disabled", source: "aerodatabox" });
    expect(calls).toEqual([]);
  });
  it("no_origin / no_location / no_dates", async () => {
    expect(await run(trip(), [])).toMatchObject({ reason: "no_origin" });
    expect(await run(trip({ destination: { kind: "freetext", name: "x", countryCode: null } }))).toMatchObject({ reason: "no_location" });
    expect(await run(trip({ timing: { kind: "none" } }))).toMatchObject({ reason: "no_dates" });
    expect(calls).toEqual([]);
  });
  it("trip origins win over home airports; first 2 only", async () => {
    const f = await run(trip({ originAirports: ["fra", "MUC", "VIE"] }), ["HAM"]);
    expect(f.status === "ok" && f.data.origins).toEqual(["FRA", "MUC"]);
  });
  it("full lookup: routes, out/back FIDS windows, weekday pattern, source and check date", async () => {
    const f = await run(trip());
    expect(f).toMatchObject({ status: "ok", source: "aerodatabox", fetchedAt: "2026-10-28T08:00:00.000Z", stale: false });
    if (f.status !== "ok") throw new Error();
    expect(calls.filter((c) => c.startsWith("R"))).toEqual(["R FRA 2027-03-15"]);
    expect(calls.filter((c) => c.startsWith("F FRA"))).toHaveLength(2);
    expect(calls.some((c) => c.startsWith("F AGP 2027-03-10"))).toBe(true);
    expect(calls.some((c) => c.startsWith("N LH1148"))).toBe(true);
    expect(f.data.pairs.find((p) => p.to === "AGP")?.status).toBe("found");
    expect(f.data.legs.find((l) => l.number === "LH 1148")?.operatingDays?.days).toBe(2);
  });
  it("origin that serves no gateway: no FIDS calls", async () => {
    const saved = routes.splice(0, routes.length);
    routes.push({ to: "LHR", perDay: 3, operators: [] });
    const f = await run(trip());
    routes.splice(0, routes.length, ...saved);
    expect(calls.filter((c) => c.startsWith("F"))).toEqual([]);
    expect(f.status === "ok" && f.data.pairs.every((p) => p.status !== "found")).toBe(true);
  });
  it("proxy mode skips the weekday lookup", async () => {
    await run(trip({ timing: { kind: "date", startDate: "2038-03-13" } }));
    expect(calls.some((c) => c.startsWith("N"))).toBe(false);
    expect(calls).toContain("R FRA 2026-03-15");
  });
  it("quota guard refusals: ok fact, quotaLimited, pairs not_checked", async () => {
    cacheState.refuse = true;
    const f = await run(trip());
    expect(f.status === "ok" && f.data.quotaLimited && f.data.pairs.every((p) => p.status === "not_checked")).toBe(true);
  });
  it("zero budget: nothing fetched", async () => {
    const f = await run(trip(), ["FRA"], 0);
    expect(calls).toEqual([]);
    expect(f.status === "ok" && f.data.pairs.every((p) => p.status === "not_checked")).toBe(true);
  });
  it("trip unit cap stops further fetches", async () => {
    const f = await run(trip({ originAirports: ["FRA", "MUC"] }));
    const units = calls.reduce((n, c) => n + (c.startsWith("R") ? 6 : 2), 0);
    expect(units).toBeLessThanOrEqual(32);
    expect(f.status).toBe("ok");
  });
});
