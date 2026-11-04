import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@/lib/server/discover/save-purpose", () => ({ saveSearchAsPurpose: h.save }));

import { POST } from "./route";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body?: unknown) => new Request("http://x/api/destination-search/s/save-purpose", { method: "POST", body: body === undefined ? "not json" : JSON.stringify(body) });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/destination-search/[id]/save-purpose", () => {
  it("passes id and body on and answers { purposeId, name, created } with no-store", async () => {
    h.save.mockResolvedValue({ ok: true, data: { purposeId: "p1", name: "Golf", created: true } });
    const res = await POST(req({ name: "Golf" }), params("s1"));
    expect(h.save).toHaveBeenCalledWith("s1", { name: "Golf" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ purposeId: "p1", name: "Golf", created: true });
  });
  it("a body that is not JSON goes through as {} (session first, then invalid)", async () => {
    h.save.mockResolvedValue({ ok: false, error: "invalid", issues: [{ path: "name", message: "Required" }] });
    const res = await POST(req(), params("s1"));
    expect(h.save).toHaveBeenCalledWith("s1", {});
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "invalid", issues: [{ path: "name", message: "Required" }] });
  });
  it.each([
    ["unauthenticated", 401],
    ["not_found", 404],
    ["conflict", 409],
    ["busy", 409],
    ["rate_limited", 429],
    ["failed", 500],
  ] as const)("%s -> %i with { error }", async (error, status) => {
    h.save.mockResolvedValue({ ok: false, error });
    const res = await POST(req({ name: "x" }), params("s1"));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error });
  });
});
