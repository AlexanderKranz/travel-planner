import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const assertUnits = vi.fn<(n: number) => Promise<void>>(async () => undefined);
vi.mock("@/lib/server/flights-quota", () => ({ assertUnits: (n: number) => assertUnits(n) }));

import { AeroDataBoxHttpError, FlightsRequestError, fetchDepartures, fetchFlightDates, fetchRoutesDaily, validateRequest } from "./aerodatabox";

const fx = (n: string) => readFileSync(`${__dirname}/__fixtures__/aerodatabox/${n}`, "utf8");
const respond = (body: string, status = 200, remaining = "340") =>
  new Response(body, { status, headers: { "x-ratelimit-api-units-remaining": remaining } });

const fetchMock = vi.fn();
let testNo = 0; // the rate-limit chain is module state: every test starts later than the previous one
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-28T10:00:00Z").getTime() + ++testNo * 3_600_000);
  process.env.AERODATABOX_API_KEY = "test-key";
  assertUnits.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = async <T>(p: Promise<T>) => {
  const r = p.then((v) => v, (e: unknown) => e);
  await vi.advanceTimersByTimeAsync(5000);
  return r;
};

describe("client", () => {
  it("sends the RapidAPI headers, reads units and quota from the response", async () => {
    fetchMock.mockResolvedValueOnce(respond(fx("routes-daily-FRA-2027-03-14.json")));
    const r = (await settle(fetchRoutesDaily("FRA", "2027-03-14"))) as Awaited<ReturnType<typeof fetchRoutesDaily>>;
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://aerodatabox.p.rapidapi.com/airports/iata/FRA/stats/routes/daily/2027-03-14");
    expect(init.headers).toMatchObject({ "x-rapidapi-key": "test-key", "x-rapidapi-host": "aerodatabox.p.rapidapi.com" });
    expect(r.units).toBe(6);
    expect(r.quotaRemaining).toBe(340);
    expect(r.data.find((x) => x.to === "MUC")?.perDay).toBe(11);
    expect(assertUnits).toHaveBeenCalledWith(6);
  });

  it("departures: 12 h local window per am/pm, leg params, 2 units", async () => {
    fetchMock.mockImplementation(async () => respond(fx("fids-departures-FRA-2027-03-06.json")));
    await settle(fetchDepartures("FRA", "2027-03-06", "am"));
    await settle(fetchDepartures("FRA", "2027-03-06", "pm"));
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toContain("/flights/airports/iata/FRA/2027-03-06T00:00/2027-03-06T11:59?");
    expect(urls[1]).toContain("/2027-03-06T12:00/2027-03-06T23:59?");
    expect(urls[0]).toContain("withLeg=true");
    expect(urls[0]).toContain("withCodeshared=false");
    expect(assertUnits).toHaveBeenCalledWith(2);
  });

  it("flight dates: compact number, month range", async () => {
    fetchMock.mockResolvedValueOnce(respond(fx("flight-dates-LH1148-2027-03.json")));
    const r = (await settle(fetchFlightDates("LH 1148", "2027-03"))) as { data: string[] };
    expect(fetchMock.mock.calls[0][0]).toContain("/flights/number/LH1148/dates/2027-03-01/2027-03-31");
    expect(r.data).toHaveLength(25);
  });

  it("HTTP 400 throws an error carrying the charged units and quota", async () => {
    fetchMock.mockResolvedValueOnce(respond('{"message":"x"}', 400, "338"));
    const e = await settle(fetchDepartures("FRA", "2027-03-06", "am"));
    expect(e).toBeInstanceOf(AeroDataBoxHttpError);
    expect(e).toMatchObject({ status: 400, units: 2, quotaRemaining: 338 });
  });

  it("rejects dates beyond 365 days without calling", async () => {
    const e = await settle(fetchDepartures("FRA", "2028-03-04", "am"));
    expect(e).toBeInstanceOf(FlightsRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assertUnits).not.toHaveBeenCalled();
  });

  it("spaces consecutive requests by at least 1.1 s", async () => {
    const starts: number[] = [];
    fetchMock.mockImplementation(async () => (starts.push(Date.now()), respond(fx("flight-dates-LH1148-2027-03.json"))));
    await settle(Promise.all([fetchFlightDates("LH1148", "2027-03"), fetchFlightDates("LH1150", "2027-03")]));
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1100);
  });

  it("a refused quota guard stops before the request", async () => {
    assertUnits.mockRejectedValueOnce(Object.assign(new Error("cap"), { name: "QuotaGuardError" }));
    const e = await settle(fetchRoutesDaily("FRA", "2027-03-14"));
    expect((e as Error).name).toBe("QuotaGuardError");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("validateRequest", () => {
  const today = "2026-10-28";
  it("accepts the edges, rejects outside", () => {
    expect(() => validateRequest({ dates: ["2027-10-28"] }, today)).not.toThrow();
    expect(() => validateRequest({ dates: ["2027-10-29"] }, today)).toThrow(FlightsRequestError);
    expect(() => validateRequest({ dates: ["2025-10-28"] }, today)).not.toThrow();
    expect(() => validateRequest({ dates: ["2025-10-27"] }, today)).toThrow();
  });
  it("IATA, flight number, window", () => {
    expect(() => validateRequest({ iata: "fra", dates: [] }, today)).toThrow();
    expect(() => validateRequest({ number: "LH1148", dates: [] }, today)).not.toThrow();
    expect(() => validateRequest({ number: "4Y502", dates: [] }, today)).not.toThrow();
    expect(() => validateRequest({ number: "LH 1148", dates: [] }, today)).toThrow();
    expect(() => validateRequest({ dates: [], windowHours: 13 }, today)).toThrow();
  });
});
