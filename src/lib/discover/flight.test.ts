import { describe, expect, it } from "vitest";
import { flightRadiusKm } from "@/lib/flights/estimate";
import { assessFlight } from "./flight";

const MALAGA = { lat: 36.72, lon: -4.42 };
const MARBELLA = { lat: 36.51, lon: -4.88 };
const PALMA = { lat: 39.57, lon: 2.65 };
const FARO = { lat: 37.02, lon: -7.93 };
const OFFENBACH = { lat: 50.1, lon: 8.76 };
const MID_ATLANTIC = { lat: 0, lon: -30 };

describe("assessFlight (step 2, no network)", () => {
  it("E1: 3 h from FRA, Costa del Sol (Marbella -> AGP) and Algarve (Faro) pass with a flight line", () => {
    const agp = assessFlight(MARBELLA, { origins: ["FRA"], maxHours: 3 });
    expect(agp).toMatchObject({ pass: true, nearAirport: false, flight: { origin: "FRA", gateway: "AGP" } });
    if (agp.pass) expect(agp.flight!.minutes).toBeGreaterThanOrEqual(160);
    const fao = assessFlight(FARO, { origins: ["FRA"], maxHours: 3 });
    expect(fao).toMatchObject({ pass: true, flight: { origin: "FRA", gateway: "FAO" } });
  });

  it("E2: the same search with a 2 h limit drops Malaga (too far) and keeps Mallorca (124 min)", () => {
    expect(assessFlight(MALAGA, { origins: ["FRA"], maxHours: 2 })).toEqual({ pass: false });
    const pmi = assessFlight(PALMA, { origins: ["FRA"], maxHours: 2 });
    expect(pmi).toMatchObject({ pass: true, flight: { origin: "FRA", gateway: "PMI", minutes: 124 } });
  });

  it("the radius is pinned: 2 h = 1,330 km", () => {
    expect(flightRadiusKm(2)).toBe(1330);
  });

  it("no limit: no filter, the estimate is still shown", () => {
    // The smallest distance over origins x gateways wins; Granada (GRX) is the nearer gateway of Malaga from FRA.
    const r = assessFlight(MALAGA, { origins: ["FRA"], maxHours: null });
    expect(r).toMatchObject({ pass: true, flight: { origin: "FRA" } });
    if (r.pass) expect(["AGP", "GRX"]).toContain(r.flight!.gateway);
  });

  it("E3/E4: no airports -> no estimate, no radius, whatever the limit says", () => {
    expect(assessFlight(MALAGA, { origins: [], maxHours: 2 })).toEqual({ pass: true, flight: null, nearAirport: false });
    expect(assessFlight(MALAGA, { origins: [], maxHours: null })).toEqual({ pass: true, flight: null, nearAirport: false });
  });

  it("under 250 km from an origin: passes, no flight line, close to your airport (even under a limit)", () => {
    expect(assessFlight(OFFENBACH, { origins: ["FRA"], maxHours: 1 })).toEqual({ pass: true, flight: null, nearAirport: true });
  });

  it("no gateway within 150 km: dropped under a limit, kept without a flight line otherwise", () => {
    expect(assessFlight(MID_ATLANTIC, { origins: ["FRA"], maxHours: 3 })).toEqual({ pass: false });
    expect(assessFlight(MID_ATLANTIC, { origins: ["FRA"], maxHours: null })).toEqual({ pass: true, flight: null, nearAirport: false });
  });

  it("at most 2 origins: a third airport cannot let a place pass", () => {
    // Faro is too far from FRA and MUC for 2 h; LIS is close. Only the first two origins count, as in the flight check.
    expect(assessFlight(FARO, { origins: ["FRA", "MUC", "LIS"], maxHours: 2 })).toEqual({ pass: false });
    expect(assessFlight(FARO, { origins: ["LIS", "FRA", "MUC"], maxHours: 2 })).toMatchObject({ pass: true });
  });

  it("with two origins the closer one is used", () => {
    const r = assessFlight(PALMA, { origins: ["HAM", "FRA"], maxHours: 2 });
    expect(r).toMatchObject({ pass: true, flight: { origin: "FRA", gateway: "PMI" } });
    expect(assessFlight(PALMA, { origins: ["HAM"], maxHours: 2 })).toEqual({ pass: false });
  });

  it("unknown origin codes are ignored (nothing to measure from)", () => {
    expect(assessFlight(MALAGA, { origins: ["ZZZ"], maxHours: 2 })).toEqual({ pass: true, flight: null, nearAirport: false });
  });
});
