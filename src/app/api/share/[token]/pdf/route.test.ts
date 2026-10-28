import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const getShared = vi.fn();
vi.mock("@/lib/server/plan-document", () => ({ getSharedPlanDocument: (...a: unknown[]) => getShared(...a) }));
vi.mock("@/lib/server/events", () => ({ logEvent: vi.fn() }));
vi.mock("@/lib/pdf/render", () => ({ renderPlanPdf: async () => Buffer.from("%PDF-1.7 fake") }));

import { resetRateLimits } from "@/lib/server/rate-limit";
import golf from "@/lib/server/__fixtures__/plan-document-golf.json";
import { GET } from "./route";

const TOKEN = "A".repeat(43);
const call = (token: string) =>
  GET(new Request("http://x/api/share/t/pdf", { headers: { "x-forwarded-for": "1.2.3.4" } }), {
    params: Promise.resolve({ token }),
  });

describe("GET /api/share/[token]/pdf", () => {
  beforeEach(() => {
    resetRateLimits();
    getShared.mockReset();
  });

  it("404 on bad token format without touching the DB", async () => {
    expect((await call("short")).status).toBe(404);
    expect(getShared).not.toHaveBeenCalled();
  });

  it("404 when the document is missing", async () => {
    getShared.mockResolvedValue(null);
    expect((await call(TOKEN)).status).toBe(404);
  });

  it("returns a PDF with safe headers", async () => {
    getShared.mockResolvedValue(golf);
    const res = await call(TOKEN);
    expect(res.status).toBe(200);
    expect(getShared).toHaveBeenCalledWith(TOKEN, "pdf");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="[a-z0-9-]+\.pdf"$/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("429 after 6 requests per minute per IP", async () => {
    getShared.mockResolvedValue(golf);
    for (let i = 0; i < 6; i++) expect((await call(TOKEN)).status).toBe(200);
    const res = await call(TOKEN);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });
});
