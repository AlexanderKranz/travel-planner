import { describe, expect, it } from "vitest";
import { assessDrive } from "./drive";

const frankfurt = { lat: 50.11, lon: 8.68 };
describe("assessDrive (straight-line cutoff, no network)", () => {
  it("Munich (~300 km) passes a 4 h limit, Marseille (~800 km) does not", () => {
    expect(assessDrive({ lat: 48.14, lon: 11.58 }, frankfurt, 4)).toEqual({ pass: true });
    expect(assessDrive({ lat: 43.3, lon: 5.37 }, frankfurt, 4)).toEqual({ pass: false });
  });
  it("is generous: it never decides a close case (cutoff is 120 km/h of straight line)", () => {
    // Hamburg is ~395 km straight-line from Frankfurt and a 4.5 h drive; a 3.5 h limit still reaches ORS (cutoff 420 km)
    expect(assessDrive({ lat: 53.55, lon: 9.99 }, frankfurt, 3.5)).toEqual({ pass: true });
  });
  it("12 h reaches Palma by straight line (ORS then says no road)", () => {
    expect(assessDrive({ lat: 39.57, lon: 2.65 }, frankfurt, 12)).toEqual({ pass: true });
  });
});
