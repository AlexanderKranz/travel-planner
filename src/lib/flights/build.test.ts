import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeFids, normalizeFlightDates } from "@/lib/integrations/aerodatabox-normalize";
import { approxBlockMin, buildFlightsFacts, compactNumber, legsForPair, type BuildFlightsInput } from "./build";
import { flightDates } from "./lookups";

const fx = (n: string) => JSON.parse(readFileSync(`${__dirname}/../integrations/__fixtures__/aerodatabox/${n}`, "utf8"));
const TODAY = "2026-10-28";
const fraOut = normalizeFids(fx("fids-departures-FRA-2027-03-06.json"));
const agpBack = normalizeFids(fx("fids-departures-AGP-2026-03-18-past.json"));
const gw = [{ iata: "AGP", name: "Málaga", km: 55 }];

function input(over: Partial<BuildFlightsInput> = {}): BuildFlightsInput {
  return {
    today: TODAY,
    dates: flightDates({ timing: { kind: "date", startDate: "2027-03-06" }, lengthDays: 5 }, TODAY)!,
    origins: ["FRA"],
    gateways: gw,
    maxBlockMin: null,
    routes: { FRA: { data: [{ to: "AGP", perDay: 1.714, operators: [{ iata: "LH", name: "Lufthansa" }] }], complete: true } },
    departures: { out: { FRA: { data: fraOut, complete: true } }, back: { AGP: { data: [], complete: true } } },
    flightDates: {},
    quotaLimited: false,
    ...over,
  };
}

describe("legsForPair", () => {
  it("LH 1148 FRA to AGP: times, block time across the day, airline from the prefix", () => {
    const legs = legsForPair("out", "FRA", "AGP", "2027-03-06", fraOut, null);
    const lh = legs.find((l) => l.number === "LH 1148")!;
    expect(lh).toMatchObject({ dep: "09:20", arr: "12:20", arrDayOffset: 0, blockMin: 180, airline: "Lufthansa", date: "2027-03-06" });
  });
  it("names 4Y from the table, never 'Flight Alaska'", () => {
    const l = legsForPair("out", "FRA", "AGP", "2027-03-06", fraOut, null).find((x) => x.number === "4Y 502")!;
    expect(l.airline).toBe("Eurowings Discover");
  });
  it("unknown prefix with a placeholder name has no airline", () => {
    const l = legsForPair("out", "FRA", "AGP", "d", [{ ...fraOut.find((x) => x.number === "LH 1148")!, number: "ZZ 12", airlineIata: undefined, airlineName: "Flight Alaska" }], null);
    expect(l[0].airline).toBeNull();
  });
  it("block time across time zones and midnight", () => {
    const [l] = legsForPair("out", "FRA", "AGP", "d", [{
      number: "LH 9", to: "AGP", depLocal: "2027-03-06 23:30", depUtc: "2027-03-06T22:30Z", arrLocal: "2027-03-07 02:45", arrUtc: "2027-03-07T01:45Z",
    }], null);
    expect(l).toMatchObject({ arrDayOffset: 1, blockMin: 195, dep: "23:30", arr: "02:45" });
  });
  it("flags tooLong, dedupes codeshares preferring the operator's own number, drops other destinations", () => {
    const base = { to: "AGP", depLocal: "2027-03-06 09:20", depUtc: "2027-03-06T08:20Z", arrLocal: "2027-03-06 12:20", arrUtc: "2027-03-06T11:20Z" };
    const legs = legsForPair("out", "FRA", "AGP", "d", [
      { ...base, number: "LX 7", airlineIata: "LH", operatorIata: "LH" },
      { ...base, number: "LH 1148", airlineIata: "LH" },
      { ...base, number: "LH 5", to: "MUC" },
    ], 120);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ number: "LH 1148", tooLong: true });
  });
  it("skips entries without arrival times or invalid numbers", () => {
    expect(legsForPair("out", "FRA", "AGP", "d", [{ number: "LH 1", to: "AGP", depLocal: "2027-03-06 09:20", depUtc: "2027-03-06T08:20Z" }], null)).toEqual([]);
  });
});

describe("approxBlockMin / compactNumber", () => {
  it("FRA-AGP approx. block time (30 min + 800 km/h)", () => expect(approxBlockMin("FRA", "AGP")).toBe(165));
  it("unknown airport gives 0", () => expect(approxBlockMin("FRA", "QQQ")).toBe(0));
  it("compacts", () => {
    expect(compactNumber("LH 1148")).toBe("LH1148");
    expect(compactNumber("bad")).toBeNull();
  });
});

describe("buildFlightsFacts", () => {
  it("found pair with legs, perDay rounded, operators, weekdays from flight dates", () => {
    const f = buildFlightsFacts(input({ flightDates: { LH1148: normalizeFlightDates(fx("flight-dates-LH1148-2027-03.json")) } }));
    expect(f.pairs[0]).toMatchObject({ from: "FRA", to: "AGP", status: "found", perDay: 1.7, toName: "Málaga" });
    const lh = f.legs.find((l) => l.number === "LH 1148")!;
    expect(lh.operatingDays).toEqual({ days: 25, of: 31, month: "2027-03" });
    expect(lh.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(f.legs.every((l) => l.dir === "out")).toBe(true);
    expect(f.mode).toEqual({ out: "schedule", back: "schedule" });
  });
  it("max 6 legs per direction, sorted fitting first", () => {
    const f = buildFlightsFacts(input({ maxBlockMin: 190 }));
    expect(f.legs.length).toBeLessThanOrEqual(6);
    const flags = f.legs.map((l) => !!l.tooLong);
    expect(flags).toEqual([...flags].sort((a, b) => Number(a) - Number(b)));
  });
  it("not_published beyond 180 days when the origin does not serve the gateway", () => {
    const dates = flightDates({ timing: { kind: "date", startDate: "2027-06-12" }, lengthDays: 3 }, TODAY)!;
    const base = input({ dates, routes: { FRA: { data: [], complete: true } }, departures: { out: {}, back: {} } });
    expect(buildFlightsFacts(base).pairs[0].status).toBe("not_published");
  });
  it("none for dates within 180 days", () => {
    const dates = flightDates({ timing: { kind: "date", startDate: "2026-12-05" }, lengthDays: 3 }, TODAY)!;
    const f = buildFlightsFacts(input({ dates, routes: { FRA: { data: [], complete: true } }, departures: { out: {}, back: {} } }));
    expect(f.pairs[0].status).toBe("none");
  });
  it("not_checked when nothing was fetched", () => {
    const f = buildFlightsFacts(input({ routes: { FRA: null }, departures: { out: { FRA: null }, back: { AGP: null } }, quotaLimited: true }));
    expect(f.pairs[0].status).toBe("not_checked");
    expect(f.quotaLimited).toBe(true);
    expect(f.legs).toEqual([]);
  });
  it("proxy mode (golf trip): both directions found from past fixtures, never none", () => {
    const dates = flightDates({ timing: { kind: "date", startDate: "2038-03-13" }, lengthDays: 5 }, TODAY)!;
    const f = buildFlightsFacts(
      input({
        dates,
        departures: {
          out: { FRA: { data: normalizeFids(fx("fids-departures-FRA-2026-03-07-past.json")), complete: true } },
          back: { AGP: { data: agpBack, complete: true } },
        },
      }),
    );
    expect(f.mode).toEqual({ out: "proxy", back: "proxy" });
    expect(f.checkedDates).toEqual({ out: "2026-03-14", back: "2026-03-18" });
    expect(f.pairs[0].status).toBe("found");
    expect(f.legs.filter((l) => l.dir === "back").map((l) => l.number)).toEqual(["VL 1151"]);
    expect(f.legs.find((l) => l.dir === "back")).toMatchObject({ from: "AGP", to: "FRA", dep: "17:15", date: "2026-03-18" });
  });
  it("proxy mode without legs is not_published, not none", () => {
    const dates = flightDates({ timing: { kind: "date", startDate: "2038-03-13" }, lengthDays: 5 }, TODAY)!;
    const f = buildFlightsFacts(input({ dates, routes: { FRA: { data: [], complete: true } }, departures: { out: {}, back: {} } }));
    expect(f.pairs[0].status).toBe("not_published");
  });
  it("found pairs sort first", () => {
    const f = buildFlightsFacts(input({
      gateways: [{ iata: "XRY", name: "Jerez", km: 10 }, ...gw],
      routes: { FRA: { data: [{ to: "AGP", perDay: 1, operators: [] }], complete: true } },
    }));
    expect(f.pairs.map((p) => p.to)).toEqual(["AGP", "XRY"]);
  });
  it("no gateways gives no pairs", () => expect(buildFlightsFacts(input({ gateways: [] })).pairs).toEqual([]));
});
