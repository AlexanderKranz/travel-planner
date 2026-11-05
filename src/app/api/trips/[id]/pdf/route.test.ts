import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  session: { userId: "u1" } as { userId: string } | null,
  doc: { ok: true, doc: { plan: { days: [] } } } as unknown,
  pdf: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock("@/lib/server/session", () => ({ getUserSession: async () => h.session }));
vi.mock("@/lib/server/plan-document", () => ({ getOwnerPlanDocumentResult: async () => h.doc }));
vi.mock("@/lib/server/events", () => ({ logEvent: h.logEvent }));
vi.mock("@/lib/pdf/response", () => ({ pdfResponse: h.pdf }));

import { resetRateLimits } from "@/lib/server/rate-limit";
import { GET } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";
const call = (id = ID) => GET(new Request("http://x/api/trips/x/pdf"), { params: Promise.resolve({ id }) });

beforeEach(() => {
  resetRateLimits();
  h.session = { userId: "u1" };
  h.doc = { ok: true, doc: { plan: { days: [] } } };
  h.pdf.mockReset().mockResolvedValue(new Response("pdf", { status: 200 }));
  h.logEvent.mockReset();
});

describe("GET /api/trips/[id]/pdf (every access level, sharing spec 1.1)", () => {
  it("a grantee of a shared trip (read access included) gets the PDF: the route only needs a visible trip", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(h.pdf).toHaveBeenCalledWith(expect.anything(), "owner", "u1");
  });

  it("a stranger (the trip is not visible through RLS) gets 404", async () => {
    h.doc = { ok: false, error: "not_found" };
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(h.pdf).not.toHaveBeenCalled();
  });

  it("a visible trip without a plan is 409, a read failure 500, signed out 401, a bad id 404", async () => {
    h.doc = { ok: false, error: "no_plan" };
    expect((await call()).status).toBe(409);
    h.doc = { ok: false, error: "failed" };
    expect((await call()).status).toBe(500);
    h.session = null;
    expect((await call()).status).toBe(401);
    h.session = { userId: "u1" };
    expect((await call("nope")).status).toBe(404);
  });

  it("a render failure is 500 and logged without content", async () => {
    h.pdf.mockRejectedValue(new Error("boom"));
    const res = await call();
    expect(res.status).toBe(500);
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "pdf.failed", userId: "u1" }));
  });
});
