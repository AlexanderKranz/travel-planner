import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const run = vi.fn();
vi.mock("@/lib/server/place-retries", () => ({ runPlaceRetries: (...a: unknown[]) => run(...a) }));
const logEvent = vi.fn();
vi.mock("@/lib/server/events", () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

import { GET } from "./route";

const req = (auth?: string) => new Request("http://localhost/api/cron/place-retries", { headers: auth ? { authorization: auth } : {} });

describe("GET /api/cron/place-retries", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    run.mockReset();
    logEvent.mockReset();
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("401 without the header, nothing runs", async () => {
    expect((await GET(req())).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it("401 with a wrong secret", async () => {
    expect((await GET(req("Bearer wrong"))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it("401 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(req("Bearer undefined"))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it("200 with the right secret and returns the summary", async () => {
    run.mockResolvedValue({ expired: 0, claimed: 2, done: 1, failed: 1, gaveUp: 0 });
    const res = await GET(req("Bearer cron-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, claimed: 2, done: 1 });
  });
  it("500 and an error event when the run throws", async () => {
    run.mockRejectedValue(new Error("boom"));
    const res = await GET(req("Bearer cron-secret"));
    expect(res.status).toBe(500);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "cron.place_retries_failed", level: "error" }));
  });
});
