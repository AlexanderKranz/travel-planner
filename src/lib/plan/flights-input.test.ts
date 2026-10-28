import { describe, expect, it } from "vitest";
import type { Fact } from "@/lib/domain/facts";
import type { FlightsFacts } from "@/lib/domain/flights";
import type { TripFacts } from "@/lib/domain/facts";
import proxy from "@/lib/flights/__fixtures__/flights-fact-proxy.json";
import mixed from "@/lib/flights/__fixtures__/flights-fact-mixed.json";
import { flightsFrom } from "./input";
import { assemblePlan } from "./assemble";

const withFlights = (f: Fact<FlightsFacts> | undefined) => ({ flights: f }) as unknown as TripFacts;
const proxyFact = proxy as Fact<FlightsFacts>;

describe("flightsFrom", () => {
  it("is empty when flights are not wanted or the fact is unavailable", () => {
    expect(flightsFrom(withFlights(proxyFact), false).llm).toBeUndefined();
    expect(flightsFrom(withFlights(proxyFact), false).snapshot).toBeUndefined();
    expect(flightsFrom(withFlights({ status: "unavailable", reason: "no_origin" }), true).snapshot).toBeUndefined();
    expect(flightsFrom(withFlights(undefined), true).snapshot).toBeUndefined();
  });

  it("sends compact times only (no numbers, airline, dates) and a code snapshot", () => {
    const r = flightsFrom(withFlights(proxyFact), true);
    expect(r.llm).toEqual({
      mode: "proxy",
      out: [{ f: "FRA", t: "AGP", dep: "09:20", arr: "12:20" }],
      back: [{ f: "AGP", t: "FRA", dep: "13:05", arr: "16:55" }],
    });
    expect(JSON.stringify(r.llm)).not.toMatch(/LH|Lufthansa|2026|2038/);
    expect(r.snapshot?.source).toBe("aerodatabox");
    expect(r.snapshot?.legs[0].number).toBe("LH 1148");
    expect(r.foundGateways.has("AGP")).toBe(true);
  });

  it("leaves too-long legs out of the model input but keeps them in the snapshot", () => {
    const f = structuredClone(proxyFact) as Extract<Fact<FlightsFacts>, { status: "ok" }>;
    f.data.legs = f.data.legs.map((l) => ({ ...l, tooLong: true as const }));
    const r = flightsFrom(withFlights(f), true);
    expect(r.llm).toBeUndefined();
    expect(r.snapshot?.legs.every((l) => l.tooLong)).toBe(true);
  });

  it("caps legs at 3 per direction, earliest first", () => {
    const f = structuredClone(mixed) as Extract<Fact<FlightsFacts>, { status: "ok" }>;
    const base = f.data.legs.find((l) => l.dir === "out")!;
    f.data.legs = ["18:00", "07:00", "12:00", "09:00"].map((dep) => ({ ...base, dep, tooLong: undefined }));
    expect(flightsFrom(withFlights(f), true).llm?.out.map((l) => l.dep)).toEqual(["07:00", "09:00", "12:00"]);
  });
});

describe("assemblePlan flights", () => {
  it("sets plan.flights from the code snapshot, not from the model", () => {
    const snap = flightsFrom(withFlights(proxyFact), true).snapshot!;
    const stored = { llm: { v: 1, lang: "de", trip: { dest: "X", kind: "region", days: 1, flights: true }, dayList: [{ n: 1 }], places: [], noSource: [] }, index: {} };
    const header = { title: "t", destination: "X", timing: { kind: "none" }, lengthDays: 1, group: null, purposeName: null, basis: { tripUpdatedAt: "a", groupUpdatedAt: null, purposeUpdatedAt: null }, generatedAt: "2026-10-28T00:00:00.000Z", model: "m" };
    const llm = { days: [{ n: 1, title: "T", stops: [{ place: "X", acts: [] }] }], summary: "s", notes: [], open: [], packing: [] };
    const run = (flights?: typeof snap) =>
      assemblePlan({ llm, stored, header, digest: {}, locale: "de", flights } as unknown as Parameters<typeof assemblePlan>[0]);
    const withF = run(snap);
    expect(withF.ok && withF.plan.flights?.legs).toHaveLength(2);
    const without = run();
    expect(without.ok && without.plan.flights).toBeUndefined();
  });
});
