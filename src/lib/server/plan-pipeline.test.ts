import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  session: { userId: "u1", supabase: {} } as unknown,
  trip: { id: "11111111-1111-4111-8111-111111111111", lengthDays: 3, groupId: null, purposeId: "p1", timing: { kind: "none" }, updatedAt: "t" } as Record<string, unknown>,
  purpose: { id: "p1", tags: null, updatedAt: "pu" } as Record<string, unknown>,
  budgetOk: true,
  planRow: { id: "plan1", latestVersion: 1, busyUntil: null } as Record<string, unknown>,
  latest: null as unknown,
  byHash: null as unknown,
  lock: true,
  inFlight: false,
  compose: vi.fn(),
  patch: vi.fn(),
  tag: vi.fn(),
  needsTags: vi.fn(() => false),
  insert: vi.fn(async () => 2),
  release: vi.fn(async () => {}),
  saveTags: vi.fn(async () => ({ updatedAt: "pu2" })),
  assemble: vi.fn(),
  logEvent: vi.fn(),
}));

const Plan = { header: { basis: {}, timing: { kind: "none" } }, days: [{ n: 1 }, { n: 2 }, { n: 3 }] };
const stored = (hash: string, no: number) => ({ meta: { versionNo: no, model: null }, plan: Plan, input: { llm: { v: 1 }, index: {} }, inputHash: hash, costMicroUsd: 0 });

vi.mock("./session", () => ({ getUserSession: async () => h.session }));
vi.mock("./profile", () => ({ getProfile: async () => ({ ok: true, data: { role: "user", isDemo: false, birthdate: null } }) }));
vi.mock("./trips", () => ({ getTrip: async () => ({ ok: true, data: h.trip }) }));
vi.mock("./groups", () => ({ getGroup: async () => ({ ok: false }) }));
vi.mock("./purposes", () => ({ getPurpose: async () => ({ ok: true, data: h.purpose }) }));
vi.mock("./events", () => ({ logEvent: h.logEvent }));
vi.mock("./facts", () => ({ getTripFacts: async () => ({}) }));
vi.mock("./ai/compose", () => ({ composePlan: h.compose, patchPlan: h.patch }));
vi.mock("./ai/purpose-tags", () => ({ needsTags: h.needsTags, tagPurpose: h.tag }));
vi.mock("./ai-usage", () => ({
  isAiEnabled: () => true,
  logAiUsage: async () => {},
  userCapMicroUsd: () => 500_000,
  berlinMidnight: () => new Date("2026-10-28T23:00:00Z"),
  getBudgetStatus: async () => ({ spentMicroUsd: 0, capMicroUsd: 500_000, resetsAt: "r", globalSpentMicroUsd: 0, globalCapMicroUsd: 5_000_000 }),
  budgetAllows: () => h.budgetOk,
}));
vi.mock("./plan-store", () => ({
  getPlanRow: async () => h.planRow,
  ensurePlan: async () => h.planRow,
  listVersionMetas: async () => [{ versionNo: 1 }],
  getVersion: async () => h.latest,
  findVersionByHash: async () => h.byHash,
  insertVersion: h.insert,
  pruneVersions: async () => {},
  acquireLock: async () => h.lock,
  releaseLock: h.release,
  savePurposeTags: h.saveTags,
  isBusy: (r: { busyUntil?: string | null } | null) => !!r?.busyUntil,
  hasBusyPlan: async () => h.inFlight,
}));
vi.mock("@/lib/plan/hash", () => ({ canonicalJson: JSON.stringify, planInputHash: () => "hash-new", purposeTagsHash: () => "th" }));
vi.mock("@/lib/plan/input", () => ({ buildPlanInput: () => ({ stored: { llm: { v: 1 }, index: {} }, header: {}, digest: {} }) }));
vi.mock("@/lib/plan/assemble", () => ({ assemblePlan: h.assemble }));
vi.mock("@/lib/plan/patch", () => ({ applyPatch: vi.fn() }));
vi.mock("@/lib/plan/edit", () => ({ applyEdit: vi.fn() }));
vi.mock("@/lib/domain/plan", async (orig) => {
  const m = await orig<typeof import("@/lib/domain/plan")>();
  return { ...m, Plan: { safeParse: (v: unknown) => ({ success: true, data: v }) } };
});

import { resetRateLimits } from "./rate-limit";
import { generatePlan, iteratePlan } from "./plan-pipeline";

const TRIP = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
  h.budgetOk = true;
  h.lock = true;
  h.inFlight = false;
  h.latest = stored("hash-old", 1);
  h.byHash = null;
  h.trip.lengthDays = 3;
  h.planRow = { id: "plan1", latestVersion: 1, busyUntil: null };
  h.needsTags.mockReturnValue(false);
  h.compose.mockResolvedValue({ ok: true, data: {}, usage: {} });
  h.assemble.mockReturnValue({ ok: true, plan: Plan, issues: {} });
});

describe("busy guards", () => {
  it("generate: another plan in flight for the user -> busy, no AI", async () => {
    h.inFlight = true;
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "busy" });
    expect(h.compose).not.toHaveBeenCalled();
  });
  it("generate: dedupe path respects a busy plan", async () => {
    h.latest = stored("hash-new", 1);
    h.planRow = { id: "plan1", latestVersion: 1, busyUntil: "2999-01-01T00:00:00Z" };
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "busy" });
    expect(h.insert).not.toHaveBeenCalled();
  });
  it("iterate: in flight -> busy", async () => {
    h.inFlight = true;
    expect(await iteratePlan(TRIP, 1, { days: [1], text: "x" } as never, "en")).toMatchObject({ ok: false, error: "busy" });
  });
  it("rate limit is 2 per minute", async () => {
    h.inFlight = true;
    await generatePlan(TRIP, "en");
    await generatePlan(TRIP, "en");
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "rate_limited" });
  });
});

describe("generatePlan", () => {
  it("too_long before anything else costs money", async () => {
    h.trip.lengthDays = 22;
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "too_long" });
    expect(h.compose).not.toHaveBeenCalled();
  });
  it("same hash as latest: no AI call, unchanged", async () => {
    h.latest = stored("hash-new", 1);
    // header basis is identical ({}), so nothing needs refreshing
    const res = await generatePlan(TRIP, "en");
    expect(res).toMatchObject({ ok: true, data: { unchanged: true } });
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });
  it("hash of an older version: restore version, no AI call", async () => {
    h.planRow = { id: "plan1", latestVersion: 3, busyUntil: null };
    h.latest = stored("hash-x", 3);
    h.byHash = stored("hash-new", 1);
    const res = await generatePlan(TRIP, "en");
    expect(res.ok).toBe(true);
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.insert).toHaveBeenCalledWith(expect.anything(), "plan1", expect.objectContaining({ kind: "restore", restoredFrom: 1 }));
  });
  it("budget exceeded: no AI call, no lock", async () => {
    h.budgetOk = false;
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "budget_exceeded", resetAt: "r" });
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });
  it("busy when the lock is held", async () => {
    h.lock = false;
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "busy" });
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled(); // never took it
  });
  it("lock is released when composing throws", async () => {
    h.compose.mockRejectedValue(new Error("x"));
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "failed" });
    expect(h.release).toHaveBeenCalledWith(expect.anything(), "plan1");
  });
  it("AI failure maps to its error and still releases the lock", async () => {
    h.compose.mockResolvedValue({ ok: false, error: "ai_refused" });
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "ai_refused" });
    expect(h.release).toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });
  it("assemble failure is invalid_output", async () => {
    h.assemble.mockReturnValue({ ok: false, reason: "day_count" });
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "invalid_output" });
  });
  it("tag failure continues without tags", async () => {
    h.needsTags.mockReturnValue(true);
    h.tag.mockResolvedValue({ ok: false, error: "ai_unavailable" });
    const res = await generatePlan(TRIP, "en");
    expect(res.ok).toBe(true);
    expect(h.saveTags).not.toHaveBeenCalled();
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "purpose.tag_failed" }));
    expect(h.insert).toHaveBeenCalledWith(expect.anything(), "plan1", expect.objectContaining({ kind: "generate" }));
  });
  it("saves tags and generates", async () => {
    h.needsTags.mockReturnValue(true);
    h.tag.mockResolvedValue({ ok: true, data: { v: 1 }, usage: {} });
    await generatePlan(TRIP, "en");
    expect(h.saveTags).toHaveBeenCalledWith("u1", "p1", { v: 1 }, "th");
  });
  it("rate limits at 6 per minute", async () => {
    h.budgetOk = false;
    for (let i = 0; i < 6; i++) await generatePlan(TRIP, "en");
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "rate_limited" });
  });
});

describe("iteratePlan", () => {
  it("conflict on a stale base version", async () => {
    h.planRow = { id: "plan1", latestVersion: 4, busyUntil: null };
    expect(await iteratePlan(TRIP, 3, { chips: ["more_rest"] }, "en")).toMatchObject({ ok: false, error: "conflict" });
    expect(h.patch).not.toHaveBeenCalled();
  });
  it("invalid feedback is rejected before any work", async () => {
    expect(await iteratePlan(TRIP, 1, { chips: [] }, "en")).toMatchObject({ ok: false, error: "invalid" });
  });
  it("budget exceeded: no patch call", async () => {
    h.budgetOk = false;
    expect(await iteratePlan(TRIP, 1, { chips: ["more_rest"] }, "en")).toMatchObject({ ok: false, error: "budget_exceeded" });
    expect(h.patch).not.toHaveBeenCalled();
  });
});
