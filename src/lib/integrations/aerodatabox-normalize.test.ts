import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeFids, normalizeFlightDates, normalizeRoutes } from "./aerodatabox-normalize";

const fx = (n: string) => JSON.parse(readFileSync(`${__dirname}/__fixtures__/aerodatabox/${n}`, "utf8"));

describe("normalizeFids", () => {
  it("LH 1148 FRA to AGP with local and UTC times", () => {
    const legs = normalizeFids(fx("fids-departures-FRA-2027-03-06.json"));
    const lh = legs.find((l) => l.number === "LH 1148")!;
    expect(lh).toMatchObject({
      to: "AGP", airlineIata: "LH", airlineName: "Lufthansa",
      depLocal: "2027-03-06 09:20", depUtc: "2027-03-06T08:20Z", arrLocal: "2027-03-06 12:20", arrUtc: "2027-03-06T11:20Z",
    });
    expect(lh.operatorIata).toBeUndefined();
  });
  it("keeps the 4Y prefix and the unknown-carrier placeholder name without an IATA code", () => {
    const l = normalizeFids(fx("fids-departures-FRA-2027-03-06.json")).find((x) => x.number === "4Y 502")!;
    expect(l.airlineIata).toBeUndefined();
    expect(l.airlineName).toBe("Flight Alaska");
  });
  it("drops cargo and entries without arrival IATA", () => {
    const base = fx("fids-departures-FRA-2027-03-06.json").departures[0];
    const legs = normalizeFids({
      departures: [
        { ...base, isCargo: true },
        { ...base, arrival: { ...base.arrival, airport: { name: "x" } } },
        { ...base, number: undefined },
        base,
      ],
    });
    expect(legs).toHaveLength(1);
  });
  it("marks a different operator", () => {
    const base = fx("fids-departures-FRA-2027-03-06.json").departures[0];
    const [l] = normalizeFids({ departures: [{ ...base, number: "LH 1148", airline: { name: "Air X", iata: "XX" } }] });
    expect(l.operatorIata).toBe("XX");
  });
  it("AGP return fixture", () => {
    const legs = normalizeFids(fx("fids-departures-AGP-2026-03-18-past.json"));
    expect(legs.filter((l) => l.to === "FRA").map((l) => l.number)).toEqual(["VL 1151"]);
  });
  it("rejects non-objects", () => expect(() => normalizeFids(null)).toThrow());
});

describe("normalizeRoutes", () => {
  const routes = normalizeRoutes(fx("routes-daily-FRA-2027-03-14.json"));
  it("destinations with averages and operators", () => {
    expect(routes.find((r) => r.to === "MUC")).toEqual({
      to: "MUC", perDay: 11,
      operators: [{ iata: "DE", name: "Condor" }, { iata: "LH", name: "Lufthansa" }],
    });
  });
  it("drops the unnamed placeholder operator", () => {
    expect(routes.find((r) => r.to === "FCO")!.operators.map((o) => o.name)).toEqual(["Lufthansa", "easyJet", "ITA Airways"]);
    expect(routes.find((r) => r.to === "LYS")!.operators).toEqual([]);
  });
});

describe("normalizeFlightDates", () => {
  it("sorted ISO dates", () => {
    const d = normalizeFlightDates(fx("flight-dates-LH1148-2027-03.json"));
    expect(d).toHaveLength(25);
    expect(d[0]).toBe("2027-03-01");
  });
  it("rejects garbage", () => expect(() => normalizeFlightDates(["x"])).toThrow());
});
