import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  afterFns: [] as (() => Promise<void>)[],
  warmFacts: vi.fn(async () => {}),
  tagTrip: vi.fn(),
  tagAndSave: vi.fn(),
  getPurpose: vi.fn(),
  logUsage: vi.fn(async () => {}),
  aiOn: true,
  budgetOk: true,
}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => void h.afterFns.push(fn) }));
vi.mock("./facts", () => ({ warmTripFacts: h.warmFacts }));
vi.mock("./facts/activity-lookups", () => ({ loadActivityLookups: vi.fn() }));
vi.mock("./purposes", () => ({ getPurpose: h.getPurpose }));
vi.mock("./purpose-tagging", () => ({ wantsTags: (p: { tags: unknown } | null) => !!p && p.tags == null, tagAndSave: h.tagAndSave }));
vi.mock("./trip-purpose-text", () => ({ tagTripPurpose: h.tagTrip }));
vi.mock("./settings", () => ({ getEffectiveEnv: async () => ({}) }));
vi.mock("./ai-usage", () => ({
  isAiEnabled: () => h.aiOn,
  getBudgetStatus: async () => ({}),
  budgetAllows: () => h.budgetOk,
  logAiUsage: h.logUsage,
}));

import type { Trip } from "@/lib/domain/trip";
import { scheduleTripWarm } from "./warm";

const session = {
  userId: "u1",
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "user", is_demo: false } }) }) }) }) },
} as never;
const TAGS = { v: 2, interests: ["golf"], custom: [], hard: [], soft: [], summary: "Golf" };
const baseTrip = { id: "t1", ownerId: "u1", access: "owner", purposeId: null, updatedAt: "t0", destination: { kind: "freetext", name: "X", countryCode: null } } as unknown as Trip;

beforeEach(() => {
  h.afterFns = [];
  h.aiOn = true;
  h.budgetOk = true;
  h.warmFacts.mockClear();
  h.tagTrip.mockReset().mockImplementation(async (_a: unknown, _t: unknown, p: object) => ({ purpose: { ...p, tags: TAGS } }));
  h.tagAndSave.mockReset().mockImplementation(async (_u: string, p: object) => ({ ...p, tags: TAGS }));
  h.getPurpose.mockReset();
});

const run = async (trip: Trip) => {
  await scheduleTripWarm(session, trip, "de");
  await h.afterFns[0]();
};

describe("scheduleTripWarm: one-off trip purpose (spec trip-purpose-text P4)", () => {
  const oneOff = { ...baseTrip, purposeText: "Golf mit einem Freund" } as Trip;

  it("tags the text once after the response, charged to the actor, then warms with the tagged purpose", async () => {
    await run(oneOff);
    expect(h.tagTrip).toHaveBeenCalledOnce();
    const [actor, trip, purpose, ctx] = h.tagTrip.mock.calls[0];
    expect(actor).toMatchObject({ userId: "u1" });
    expect(trip).toBe(oneOff);
    expect(purpose).toMatchObject({ id: "", text: "Golf mit einem Freund" });
    await ctx.onUsage({ task: "purpose_tags" });
    expect(h.logUsage).toHaveBeenCalledWith("u1", false, { task: "purpose_tags" });
    expect(h.tagAndSave).not.toHaveBeenCalled();
    expect(h.warmFacts).toHaveBeenCalledWith(oneOff, expect.objectContaining({ tags: TAGS }), expect.anything(), expect.anything());
  });
  it("no tagging when the trip already has tags, AI is off or the budget is spent; warming still runs", async () => {
    await run({ ...oneOff, purposeTags: TAGS } as Trip);
    expect(h.tagTrip).not.toHaveBeenCalled();
    h.afterFns = [];
    h.aiOn = false;
    await run(oneOff);
    expect(h.tagTrip).not.toHaveBeenCalled();
    h.afterFns = [];
    h.aiOn = true;
    h.budgetOk = false;
    await run(oneOff);
    expect(h.tagTrip).not.toHaveBeenCalled();
    expect(h.warmFacts).toHaveBeenCalledTimes(3);
  });
  it("a trip without a purpose warms with none", async () => {
    await run(baseTrip);
    expect(h.warmFacts).toHaveBeenCalledWith(baseTrip, null, expect.anything(), expect.anything());
  });
  it("a saved purpose is tagged on the purpose, not the trip", async () => {
    h.getPurpose.mockResolvedValue({ ok: true, data: { id: "p1", tags: null } });
    await run({ ...baseTrip, purposeId: "p1" } as Trip);
    expect(h.tagAndSave).toHaveBeenCalledOnce();
    expect(h.tagTrip).not.toHaveBeenCalled();
  });
});
