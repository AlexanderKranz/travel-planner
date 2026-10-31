import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ run: vi.fn(), more: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/server/discover/pipeline", () => ({
  runDestinationSearch: h.run,
  showOtherDestinations: h.more,
  getDestinationSearch: h.get,
}));

import { GET as getOne, maxDuration as getMax } from "./[id]/route";
import { POST as more, maxDuration as moreMax } from "./[id]/more/route";
import { maxDuration, POST } from "./route";
import { respond } from "./respond";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body?: unknown) => new Request("http://x/api/destination-search", { method: "POST", body: body === undefined ? "not json" : JSON.stringify(body) });

beforeEach(() => vi.clearAllMocks());

describe("route contracts", () => {
  it("all three routes allow 120 s", () => {
    expect([maxDuration, getMax, moreMax]).toEqual([120, 120, 120]);
  });

  it("POST passes the body to the pipeline and answers { search } with no-store", async () => {
    h.run.mockResolvedValue({ ok: true, data: { id: "s1" } });
    const res = await POST(req({ purposeId: "p" }));
    expect(h.run).toHaveBeenCalledWith({ purposeId: "p" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ search: { id: "s1" } });
  });

  it("a body that is not JSON goes through the pipeline as {} (session first, then invalid)", async () => {
    h.run.mockResolvedValue({ ok: false, error: "invalid" });
    const res = await POST(req());
    expect(h.run).toHaveBeenCalledWith({});
    expect(res.status).toBe(422);
  });

  it("GET and more pass the id", async () => {
    h.get.mockResolvedValue({ ok: true, data: { id: "s1" } });
    h.more.mockResolvedValue({ ok: true, data: { id: "s1" } });
    expect((await getOne(new Request("http://x"), params("s1"))).status).toBe(200);
    expect(h.get).toHaveBeenCalledWith("s1");
    expect((await more(new Request("http://x", { method: "POST" }), params("s1"))).status).toBe(200);
    expect(h.more).toHaveBeenCalledWith("s1");
  });
});

describe("respond: error codes and statuses", () => {
  const status = async (error: string, extra: object = {}) => respond({ ok: false, error: error as never, ...extra });
  it("maps the codes of the search", async () => {
    const expected: Record<string, number> = {
      unauthenticated: 401,
      not_found: 404,
      invalid: 422,
      unknown_airport: 422,
      busy: 409,
      conflict: 409,
      rate_limited: 429,
      search_limit: 429,
      budget_exceeded: 429,
      ai_disabled: 503,
      ai_unavailable: 502,
      ai_refused: 502,
      invalid_output: 502,
      places_unavailable: 502,
      failed: 500,
    };
    for (const [code, s] of Object.entries(expected)) expect((await status(code)).status, code).toBe(s);
  });
  it("carries resetAt, retryAfter (also as header) and issues", async () => {
    const r = await status("rate_limited", { retryAfter: 42 });
    expect(r.headers.get("Retry-After")).toBe("42");
    expect(await r.json()).toEqual({ error: "rate_limited", retryAfter: 42 });
    expect(await (await status("search_limit", { resetAt: "2026-11-02T00:00:00.000Z" })).json()).toEqual({ error: "search_limit", resetAt: "2026-11-02T00:00:00.000Z" });
    expect(await (await status("invalid", { issues: [{ path: "months", message: "x" }] })).json()).toMatchObject({ issues: [{ path: "months" }] });
  });
});
