import { describe, expect, it } from "vitest";
import { gatewayAirports, nearestGatewayKm } from "./airports";

describe("gatewayAirports", () => {
  it("returns the 2 nearest airports within 150 km, nearest first", () => {
    const g = gatewayAirports({ lat: 36.515, lon: -4.886 }); // Marbella
    expect(g.map((a) => a.iata)).toEqual(["AGP", "GIB"]);
    expect(g[0].km).toBeLessThan(g[1].km);
    expect(nearestGatewayKm({ lat: 36.675, lon: -4.499 }, g)).toBeLessThan(2); // AGP itself
  });

  it("returns none in the middle of the ocean", () => {
    expect(gatewayAirports({ lat: 0, lon: -30 })).toEqual([]);
    expect(nearestGatewayKm({ lat: 0, lon: 0 }, [])).toBeUndefined();
  });
});
