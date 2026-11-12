import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  aiOn: true,
  budgetOk: true,
  slot: { ok: true, id: "slot-1", pending: 0 } as Record<string, unknown> | null,
  reserve: vi.fn(),
  settle: vi.fn(),
  releaseSlot: vi.fn(),
  cached: null as unknown,
  upserts: [] as Record<string, unknown>[],
  usage: vi.fn(),
  event: vi.fn(),
  budget: vi.fn(),
  allows: vi.fn(),
  profile: { role: "user", is_demo: false } as Record<string, unknown>,
}));
vi.mock("./ai-usage", () => ({
  isAiEnabled: () => h.aiOn,
  getBudgetStatus: h.budget,
  budgetAllows: (...a: unknown[]) => (h.allows(...a), h.budgetOk),
  logAiUsage: h.usage,
  berlinMidnight: () => new Date("2026-11-10T23:00:00Z"),
}));
vi.mock("./events", () => ({ logEvent: h.event }));
vi.mock("./ai-slots", () => ({ reserveAiCall: h.reserve, settleAiCall: h.settle, releaseAiCall: h.releaseSlot }));
vi.mock("./settings", () => ({ getEffectiveEnv: async () => ({}) }));
vi.mock("./supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: table === "itinerary_extracts" ? h.cached : null, error: null });
      q.upsert = async (row: Record<string, unknown>) => (h.upserts.push(row), { error: null });
      return q;
    },
  }),
}));

import { checkImages, DAILY_EXTRACTS, runItineraryAi } from "./itinerary-ai";

const session = {
  userId: "actor",
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.profile }) }) }) }) },
} as never;
const payload = { kind: "text" as const, text: "19.12.2037 Passau ab 16:00\nirgendwas" };
const extract = { stops: [{ date: "2037-12-19", place: "Passau", dep: "16:00" }], drops: { notInSource: 0, noPlace: 0, invalid: 0 } };
const ok = vi.fn();

beforeEach(() => {
  h.aiOn = true;
  h.budgetOk = true;
  h.slot = { ok: true, id: "slot-1", pending: 0 };
  h.reserve.mockReset().mockImplementation(async () => {
    if (!h.slot) throw new Error("db");
    return h.slot;
  });
  h.settle.mockReset();
  h.releaseSlot.mockReset();
  h.cached = null;
  h.upserts.length = 0;
  h.profile = { role: "user", is_demo: false };
  h.usage.mockReset();
  h.event.mockReset();
  h.allows.mockReset();
  h.budget.mockReset().mockResolvedValue({});
  ok.mockReset().mockImplementation(async (_p: unknown, ctx: { onUsage: (u: unknown) => Promise<void> }) => {
    await ctx.onUsage({ task: "itinerary_extract", costMicroUsd: 240 });
    return { ok: true, data: extract, usage: {} };
  });
});

const run = () => runItineraryAi(session, "owner", payload, { extract: ok });

describe("runItineraryAi", () => {
  it("calls Haiku once, charges the ACTING user and caches under the OWNER", async () => {
    expect(await run()).toEqual({ ok: true, extract, cached: false });
    expect(ok).toHaveBeenCalledOnce();
    expect(h.usage).toHaveBeenCalledWith("actor", false, expect.objectContaining({ task: "itinerary_extract" }));
    expect(h.upserts).toEqual([expect.objectContaining({ owner_id: "owner", hash: expect.stringMatching(/^[0-9a-f]{64}$/), stops: extract.stops, flags: extract.drops })]);
  });

  it("answers from the owner's cache without any gate, also with AI off", async () => {
    h.aiOn = false;
    h.cached = { stops: extract.stops, flags: extract.drops };
    expect(await run()).toEqual({ ok: true, extract, cached: true });
    expect(ok).not.toHaveBeenCalled();
  });

  it("ignores a cached row that fails validation", async () => {
    h.cached = { stops: [{ place: "x".repeat(200) }], flags: {} };
    expect((await run()).ok).toBe(true);
    expect(ok).toHaveBeenCalledOnce();
  });

  it.each([
    ["ai_off", () => void (h.aiOn = false)],
    ["demo", () => void (h.profile = { role: "user", is_demo: true })],
    ["rate_limited", () => void (h.slot = { ok: false, reason: "day" })],
    ["failed", () => void (h.slot = null)],
    ["budget", () => void (h.budgetOk = false)],
  ])("refuses with %s before any call", async (error, arrange) => {
    arrange();
    expect(await run()).toEqual({ ok: false, error });
    expect(ok).not.toHaveBeenCalled();
    expect(h.event).toHaveBeenCalledWith(expect.objectContaining({ event: "itinerary.extract_failed", props: expect.objectContaining({ reason: error }) }));
  });

  it("reserves a slot with the role's day limit since Berlin midnight and settles it after the call", async () => {
    expect((await run()).ok).toBe(true);
    expect(h.reserve).toHaveBeenCalledWith({
      userId: "actor",
      task: "itinerary_extract",
      perMinute: 3,
      perDay: DAILY_EXTRACTS.user,
      dayStart: new Date("2026-11-10T23:00:00Z"),
    });
    expect(h.settle).toHaveBeenCalledWith("slot-1");
    h.profile = { role: "admin", is_demo: false };
    await run();
    expect(h.reserve).toHaveBeenLastCalledWith(expect.objectContaining({ perDay: DAILY_EXTRACTS.admin }));
  });

  it("refuses when the minute limit is used up", async () => {
    h.slot = { ok: false, reason: "minute" };
    expect(await run()).toEqual({ ok: false, error: "rate_limited" });
    expect(h.settle).not.toHaveBeenCalled();
  });

  it("reserves budget for the pending slots of other requests", async () => {
    h.slot = { ok: true, id: "slot-2", pending: 2 };
    await run();
    expect(h.allows).toHaveBeenCalledWith(expect.anything(), 3 * 3_000);
  });

  it("gives the slot back when the budget refuses", async () => {
    h.budgetOk = false;
    expect(await run()).toEqual({ ok: false, error: "budget" });
    expect(h.releaseSlot).toHaveBeenCalledWith("slot-1");
    expect(h.settle).not.toHaveBeenCalled();
  });

  it("gives the slot back when the budget read throws", async () => {
    h.budget.mockRejectedValueOnce(new Error("db"));
    expect(await run()).toEqual({ ok: false, error: "failed" });
    expect(h.releaseSlot).toHaveBeenCalledWith("slot-1");
    expect(h.settle).not.toHaveBeenCalled();
  });

  it("settles the slot also when the model call fails", async () => {
    ok.mockResolvedValueOnce({ ok: false, error: "invalid_output" });
    await run();
    expect(h.settle).toHaveBeenCalledWith("slot-1");
  });

  it("maps a failed model call to failed, logs the AI error class, caches nothing", async () => {
    ok.mockResolvedValueOnce({ ok: false, error: "invalid_output" });
    expect(await run()).toEqual({ ok: false, error: "failed" });
    expect(h.upserts).toEqual([]);
    expect(h.event).toHaveBeenCalledWith(expect.objectContaining({ props: { reason: "failed", detail: "invalid_output" } }));
  });

  it("never puts content into events", async () => {
    h.aiOn = false;
    await run();
    expect(JSON.stringify(h.event.mock.calls)).not.toContain("Passau");
  });
});

describe("checkImages", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");

  it("accepts real JPEG/PNG bytes with the matching type", () => {
    expect(checkImages([{ mediaType: "image/jpeg", data: jpeg }, { mediaType: "image/png", data: png }])).toBe(true);
  });

  it("rejects a wrong declared type, a PDF, broken base64, too many and too large images", () => {
    expect(checkImages([{ mediaType: "image/png", data: jpeg }])).toBe(false);
    expect(checkImages([{ mediaType: "image/jpeg", data: Buffer.from("%PDF-1.7 xx").toString("base64") }])).toBe(false);
    expect(checkImages([{ mediaType: "image/jpeg", data: "not base64!" }])).toBe(false);
    expect(checkImages(Array.from({ length: 4 }, () => ({ mediaType: "image/jpeg", data: jpeg })))).toBe(false);
    const big = Buffer.alloc(2 * 1024 * 1024 + 3);
    big.set([0xff, 0xd8, 0xff]);
    expect(checkImages([{ mediaType: "image/jpeg", data: big.toString("base64") }])).toBe(false);
    expect(checkImages([])).toBe(false);
  });
});
