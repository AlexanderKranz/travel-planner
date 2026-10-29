import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const run = vi.fn();
vi.mock("@/lib/server/admin/budget-run", () => ({ runBudgetCheck: (...a: unknown[]) => run(...a) }));
const logEvent = vi.fn();
vi.mock("@/lib/server/events", () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));

import { GET } from "./route";

const req = (auth?: string) => new Request("http://localhost/api/cron/budget-check", { headers: auth ? { authorization: auth } : {} });

describe("GET /api/cron/budget-check", () => {
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
  it("401 when CRON_SECRET is not configured, even with a matching-looking header", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(req("Bearer undefined"))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });
  it("200 with the right secret and returns the alerts", async () => {
    run.mockResolvedValue({ alerts: [{ kind: "ai_daily", level: "warn", sent: true }] });
    const res = await GET(req("Bearer cron-secret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alerts: [{ kind: "ai_daily", level: "warn", sent: true }] });
  });
  it("500 and an error event when the check throws", async () => {
    run.mockRejectedValue(new Error("boom"));
    const res = await GET(req("Bearer cron-secret"));
    expect(res.status).toBe(500);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "cron.budget_check_failed", level: "error" }));
  });
});
