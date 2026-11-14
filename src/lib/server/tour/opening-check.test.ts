import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { openingIssues } from "./opening-check";

const place = { lat: 48.2082, lon: 16.3738, countryCode: "AT" };
/** City and process in the same zone, so sun-based tags are evaluated. */
const zone = { timeZone: "Europe/Vienna", processTimeZone: "Europe/Vienna" };
const hours = (tag: string) => new Map([["osm:n1", { key: "osm:n1", tag, checkedAt: "2026-11-14T09:00:00Z" }]]);
// 2026-11-16 is a Monday.
const run = (tag: string, arrive: string, dwellMin = 60, waitMin?: number) =>
  openingIssues({ date: "2026-11-16", stops: [{ key: "osm:n1", time: { arrive, leave: arrive, ...(waitMin ? { waitMin } : {}) }, dwellMin }], hours: hours(tag), place, ...zone });

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
  it("uses the place's coordinates for sunrise/sunset tags (review of #237)", () => {
    // Wien in mid-November: sunset about 16:20, so 17:00 is closed; the parser's default (18:00) would say open.
    expect(run("sunrise-sunset", "17:00", 30)).toEqual([{ key: "osm:n1", kind: "closed", at: "17:00", checkedAt: "2026-11-14T09:00:00Z" }]);
  });
  it("makes no claim for sun-based tags when the server runs in another zone (review of #237)", () => {
    const res = openingIssues({
      date: "2026-11-16",
      stops: [{ key: "osm:n1", time: { arrive: "17:00", leave: "17:30" }, dwellMin: 30 }],
      hours: hours("sunrise-sunset"),
      place,
      timeZone: "Europe/Vienna",
      processTimeZone: "UTC",
    });
    expect(res).toEqual([]);
  });
  it("checks a visit after midnight on the next day", () => {
    // Monday 23:00, then 00:30 on Tuesday; the place opens Tuesday only.
    const res = openingIssues({
      date: "2026-11-16",
      stops: [
        { key: "osm:x", time: { arrive: "23:00", leave: "23:30" }, dwellMin: 30 },
        { key: "osm:n1", time: { arrive: "00:30", leave: "01:00" }, dwellMin: 30 },
      ],
      hours: hours("Tu 00:00-02:00"),
      place,
      ...zone,
    });
    expect(res).toEqual([]);
  });
  it("open → unknown during the visit is not a closing", () => {
    expect(run("Mo 09:00-12:00, Mo 12:00-18:00 unknown", "11:30", 60)).toEqual([]);
  });
  it("an unparsable tag gives no claim", () => {
    expect(run("ask the porter", "10:00")).toEqual([]);
  });
  it("a stop without a tag or without times is skipped", () => {
    expect(openingIssues({ date: "2026-11-16", stops: [{ key: "osm:n2", time: { arrive: "10:00", leave: "11:00" }, dwellMin: 60 }], hours: hours("Mo 10:00-11:00"), place, ...zone })).toEqual([]);
    expect(openingIssues({ date: "2026-11-16", stops: [{ key: "osm:n1", time: undefined, dwellMin: 60 }], hours: hours("Mo off"), place, ...zone })).toEqual([]);
  });
});
