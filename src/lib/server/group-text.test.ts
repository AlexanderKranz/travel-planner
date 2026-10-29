import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  aiOn: true,
  budgetOk: true,
  parse: vi.fn(),
  updates: [] as { table: string; payload: Record<string, unknown>; eq: [string, unknown][] }[],
  usage: vi.fn(),
  event: vi.fn(),
  profile: { role: "user", is_demo: false } as Record<string, unknown>,
}));
vi.mock("./ai-usage", () => ({
  isAiEnabled: () => h.aiOn,
  getBudgetStatus: async () => ({}),
  budgetAllows: () => h.budgetOk,
  logAiUsage: h.usage,
}));
vi.mock("./ai/group-parse", () => ({ parseGroupText: h.parse }));
vi.mock("./events", () => ({ logEvent: h.event }));
vi.mock("./settings", () => ({ getEffectiveEnv: async () => ({}) }));
vi.mock("./supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) => {
      const u = { table, payload: {} as Record<string, unknown>, eq: [] as [string, unknown][] };
      const b: Record<string, unknown> = {};
      b.update = (p: Record<string, unknown>) => ((u.payload = p), b);
      b.eq = (c: string, v: unknown) => (u.eq.push([c, v]), b);
      b.select = async () => (h.updates.push(u), { data: [{ id: "x" }], error: null });
      return b;
    },
  }),
}));

import { groupTextHash } from "@/lib/plan/hash";
import { resetRateLimits } from "./rate-limit";
import { ensureGroupParse } from "./group-text";

const session = { userId: "u1", supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: h.profile }) }) }) }) } } as never;
const parsed = { v: 1, travellers: [{ count: 5 }], notes: [] };

beforeEach(() => {
  h.aiOn = true;
  h.budgetOk = true;
  h.updates.length = 0;
  h.parse.mockReset().mockResolvedValue({ ok: true, data: parsed, usage: {} });
  h.usage.mockReset();
  h.event.mockReset();
  resetRateLimits();
});

describe("ensureGroupParse", () => {
  it("parses once and caches by text hash with the secret key, scoped to the owner", async () => {
    const saved = await ensureGroupParse(session, { table: "travel_groups", id: "g1" }, "  Wir sind 5 Freunde ", false);
    expect(saved).toBe(true);
    expect(h.parse).toHaveBeenCalledOnce();
    expect(h.parse.mock.calls[0][0]).toBe("Wir sind 5 Freunde");
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({
      table: "travel_groups",
      payload: { parsed_structure: parsed, parsed_hash: groupTextHash("Wir sind 5 Freunde") },
      eq: [["id", "g1"], ["owner_id", "u1"]],
    });
  });

  it("uses the trip's own columns", async () => {
    await ensureGroupParse(session, { table: "trips", id: "t1" }, "Ich und Ben", false);
    expect(Object.keys(h.updates[0].payload).sort()).toEqual(["group_parsed", "group_parsed_at", "group_parsed_hash"]);
  });

  it.each([
    ["empty text", () => {}, " ", false],
    ["a valid parse exists", () => {}, "text", true],
    ["AI is off (kill switch)", () => { h.aiOn = false; }, "text", false],
    ["the budget is used up", () => { h.budgetOk = false; }, "text", false],
  ])("makes no call when %s", async (_n, arrange, text, valid) => {
    arrange();
    expect(await ensureGroupParse(session, { table: "travel_groups", id: "g1" }, text, valid)).toBe(false);
    expect(h.parse).not.toHaveBeenCalled();
  });

  it("a failed call never throws and saves nothing; the failure is logged without text", async () => {
    h.parse.mockResolvedValue({ ok: false, error: "ai_unavailable" });
    expect(await ensureGroupParse(session, { table: "travel_groups", id: "g1" }, "geheimer Text", false)).toBe(false);
    expect(h.updates).toHaveLength(0);
    expect(h.event).toHaveBeenCalledWith(expect.objectContaining({ event: "group.parse_failed", props: { table: "travel_groups", reason: "ai_unavailable" } }));
    expect(JSON.stringify(h.event.mock.calls)).not.toContain("geheimer");
    h.parse.mockRejectedValue(new Error("boom"));
    expect(await ensureGroupParse(session, { table: "travel_groups", id: "g1" }, "t", false)).toBe(false);
  });

  it("is rate limited per user", async () => {
    for (let i = 0; i < 20; i++) await ensureGroupParse(session, { table: "travel_groups", id: "g1" }, "t" + i, false);
    h.parse.mockClear();
    expect(await ensureGroupParse(session, { table: "travel_groups", id: "g1" }, "one more", false)).toBe(false);
    expect(h.parse).not.toHaveBeenCalled();
  });
});
