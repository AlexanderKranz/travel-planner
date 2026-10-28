import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/flights-quota", () => ({ assertUnits: async () => undefined }));

import { fetchRoutesDaily } from "./aerodatabox";

// Defect: a 200 whose body fails Zod (or a timeout after the request was sent) is charged by AeroDataBox,
// but the thrown error carries no `units`, so cached() logs units=null and the DB quota guard undercounts.
describe("charged units on non-HTTP failures", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    vi.setSystemTime(new Date("2031-01-01T10:00:00Z"));
    process.env.AERODATABOX_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ unexpected: true }), { status: 200, headers: { "x-ratelimit-api-units-remaining": "300" } })));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("schema-invalid 200 error carries the charged units", async () => {
    const p = fetchRoutesDaily("FRA", "2031-01-15").then(() => null, (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await p) as { units?: number }).toMatchObject({ units: 6 });
  });
});
