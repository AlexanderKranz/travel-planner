import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { openingIssues } from "./opening-check";

const place = { lat: 48.2082, lon: 16.3738, countryCode: "AT" };
const hours = (tag: string) => new Map([["osm:n1", { key: "osm:n1", tag, checkedAt: "2026-11-14T09:00:00Z" }]]);
// 2026-11-16 is a Monday.
const run = (tag: string, arrive: string, dwellMin = 60, waitMin?: number) =>
  openingIssues({ date: "2026-11-16", stops: [{ key: "osm:n1", time: { arrive, leave: arrive, ...(waitMin ? { waitMin } : {}) }, dwellMin }], hours: hours(tag), place });

describe("openingIssues (spec 17.4)", () => {
  it("open for the whole visit: no issue", () => {
    expect(run("Mo-Fr 09:00-18:00", "10:00")).toEqual([]);
  });
  it("closed at the visit start", () => {
    expect(run("Tu-Su 10:00-18:00", "10:20")).toEqual([{ key: "osm:n1", kind: "closed", at: "10:20", checkedAt: "2026-11-14T09:00:00Z" }]);
  });
  it("closes during the visit, with the closing time", () => {
    expect(run("Mo-Fr 09:00-17:00", "16:30")).toEqual([{ key: "osm:n1", kind: "closes", at: "17:00", checkedAt: "2026-11-14T09:00:00Z" }]);
  });
  it("uses the visit start after a window wait", () => {
    expect(run("Mo-Fr 11:00-18:00", "10:40", 60, 20)).toEqual([]);
  });
  it("an unparsable tag gives no claim", () => {
    expect(run("ask the porter", "10:00")).toEqual([]);
  });
  it("a stop without a tag or without times is skipped", () => {
    expect(openingIssues({ date: "2026-11-16", stops: [{ key: "osm:n2", time: { arrive: "10:00", leave: "11:00" }, dwellMin: 60 }], hours: hours("Mo 10:00-11:00"), place })).toEqual([]);
    expect(openingIssues({ date: "2026-11-16", stops: [{ key: "osm:n1", time: undefined, dwellMin: 60 }], hours: hours("Mo off"), place })).toEqual([]);
  });
});
