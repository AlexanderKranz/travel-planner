import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ rpc: vi.fn(), event: vi.fn() }));
vi.mock("./events", () => ({ logEvent: h.event }));
vi.mock("./supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: h.rpc }) }));

import { releaseAiCall, reserveAiCall, settleAiCall } from "./ai-slots";

const args = { userId: "u", task: "itinerary_extract", perMinute: 3, perDay: 10, dayStart: new Date("2026-11-10T23:00:00Z") };
const id = "6b1f2f8e-8f0a-4c6e-9b1a-2b9f6f0c1d2e";

beforeEach(() => {
  h.rpc.mockReset();
  h.event.mockReset();
});

describe("reserveAiCall", () => {
  it("passes the limits and parses the reply", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, id, pending: 1 }, error: null });
    expect(await reserveAiCall(args)).toEqual({ ok: true, id, pending: 1 });
    expect(h.rpc).toHaveBeenCalledWith("ai_reserve_call", {
      p_user: "u",
      p_task: "itinerary_extract",
      p_minute_limit: 3,
      p_day_limit: 10,
      p_day_start: "2026-11-10T23:00:00.000Z",
    });
    h.rpc.mockResolvedValue({ data: { ok: false, reason: "day" }, error: null });
    expect(await reserveAiCall(args)).toEqual({ ok: false, reason: "day" });
  });

  it("throws on a database error or an unexpected reply, so callers fail closed", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "x" } });
    await expect(reserveAiCall(args)).rejects.toThrow();
    h.rpc.mockResolvedValue({ data: { ok: true }, error: null });
    await expect(reserveAiCall(args)).rejects.toThrow();
  });
});

describe("settleAiCall and releaseAiCall", () => {
  it("log a returned error or a throw, and never throw themselves", async () => {
    h.rpc.mockResolvedValueOnce({ error: { code: "42501" } });
    await settleAiCall(id);
    h.rpc.mockRejectedValueOnce(new Error("net"));
    await releaseAiCall(id);
    expect(h.event.mock.calls.map((c) => c[0].props)).toEqual([
      { fn: "ai_settle_call", code: "42501" },
      { fn: "ai_release_call", code: "thrown" },
    ]);
  });

  it("log nothing on success", async () => {
    h.rpc.mockResolvedValue({ error: null });
    await settleAiCall(id);
    await releaseAiCall(id);
    expect(h.event).not.toHaveBeenCalled();
  });
});
