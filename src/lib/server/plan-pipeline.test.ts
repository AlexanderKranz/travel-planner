import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  session: { userId: "u1", supabase: {} } as { userId: string; supabase: unknown },
  itemRows: [] as unknown[],
  trip: { id: "11111111-1111-4111-8111-111111111111", ownerId: "u1", access: "owner", lengthDays: 3, groupId: null, purposeId: "p1", timing: { kind: "none" }, updatedAt: "t" } as Record<string, unknown>,
  purpose: { id: "p1", ownerId: "u1", tags: null, updatedAt: "pu" } as Record<string, unknown>,
  ownerCtx: { birthdate: "1980-05-06", homeAirports: ["MUC"], locale: "en", displayName: "Alice" } as unknown,
  logUsage: vi.fn(async () => {}),
  hasBusy: vi.fn(),
  prune: vi.fn(async () => {}),
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
  facts: {} as Record<string, unknown>,
  getFacts: vi.fn(),
  acquire: vi.fn(),
  ensure: vi.fn(),
  order: [] as string[],
  picks: [] as unknown[],
  drive: vi.fn(async () => null as unknown),
  lookups: vi.fn(),
  warm: vi.fn(),
  build: vi.fn((a: unknown) => ({ stored: { llm: { v: 1 }, index: {} }, header: {}, digest: {}, a })),
}));

const Plan = { header: { basis: {}, timing: { kind: "none" } }, days: [{ n: 1 }, { n: 2 }, { n: 3 }] };
const stored = (hash: string, no: number) => ({ meta: { versionNo: no, model: null }, plan: Plan, input: { llm: { v: 1 }, index: {} }, inputHash: hash, costMicroUsd: 0 });

vi.mock("./session", () => ({ getUserSession: async () => h.session }));
vi.mock("./profile", () => ({ getProfile: async () => ({ ok: true, data: { role: "user", isDemo: false, birthdate: "1999-01-02", homeAirports: ["FRA"] } }) }));
vi.mock("./owner-context", () => ({ loadOwnerContext: async () => h.ownerCtx }));
vi.mock("./trips", () => ({ getTrip: async () => ({ ok: true, data: h.trip }) }));
vi.mock("./groups", () => ({ getGroup: async () => ({ ok: false }) }));
vi.mock("./purposes", () => ({ getPurpose: async () => ({ ok: true, data: h.purpose }) }));
vi.mock("./events", () => ({ logEvent: h.logEvent }));
vi.mock("./facts", () => ({ getTripFacts: h.getFacts }));
vi.mock("./facts/drive-times", () => ({ getDriveTimes: h.drive }));
vi.mock("./facts/activity-lookups", () => ({ loadActivityLookups: h.lookups }));
vi.mock("./warm", () => ({ scheduleActivityWarm: h.warm }));
vi.mock("./ai/compose", () => ({ composePlan: h.compose, patchPlan: h.patch }));
vi.mock("./ai/purpose-tags", () => ({ needsTags: h.needsTags, tagPurpose: h.tag }));
vi.mock("./ai-usage", () => ({
  isAiEnabled: () => true,
  logAiUsage: h.logUsage,
  userCapMicroUsd: () => 500_000,
  berlinMidnight: () => new Date("2026-10-28T23:00:00Z"),
  getBudgetStatus: async () => ({ spentMicroUsd: 0, capMicroUsd: 500_000, resetsAt: "r", globalSpentMicroUsd: 0, globalCapMicroUsd: 5_000_000 }),
  budgetAllows: () => h.budgetOk,
}));
vi.mock("./plan-store", () => ({
  getPlanRow: async () => h.planRow,
  ensurePlan: h.ensure,
  listVersionMetas: async () => [{ versionNo: 1 }],
  getVersion: async () => h.latest,
  // Mirrors getVersionLight: the stored version without its input, plus the one input field the state reads.
  getVersionLight: async () => {
    const v = h.latest as { meta: unknown; plan: unknown; input?: { pendingPlaces?: string[] } } | null;
    return v ? { meta: v.meta, plan: v.plan, pendingPlaces: v.input?.pendingPlaces ?? [] } : null;
  },
  findVersionByHash: async () => h.byHash,
  insertVersion: h.insert,
  pruneVersions: h.prune,
  acquireLock: h.acquire,
  releaseLock: h.release,
  savePurposeTags: h.saveTags,
  isBusy: (r: { busyUntil?: string | null } | null) => !!r?.busyUntil,
  hasBusyPlan: (...args: unknown[]) => (h.hasBusy(...args), Promise.resolve(h.inFlight)),
}));
vi.mock("@/lib/plan/hash", () => ({ canonicalJson: JSON.stringify, planInputHash: () => "hash-new", purposeTagsHash: () => "th" }));
vi.mock("@/lib/plan/input", () => ({ buildPlanInput: h.build, selectPlaces: () => ({ picks: h.picks, noSource: [] }) }));
vi.mock("@/lib/plan/assemble", async (orig) => ({ ...(await orig<typeof import("@/lib/plan/assemble")>()), assemblePlan: h.assemble }));
vi.mock("@/lib/plan/patch", async (orig) => ({ ...(await orig<typeof import("@/lib/plan/patch")>()), applyPatch: vi.fn() }));
vi.mock("@/lib/plan/edit", () => ({ applyEdit: vi.fn() }));
vi.mock("@/lib/domain/plan", async (orig) => {
  const m = await orig<typeof import("@/lib/domain/plan")>();
  return { ...m, Plan: { safeParse: (v: unknown) => ({ success: true, data: v }) } };
});

// trip_items read (loadTripItems): from().select().eq().returns()
h.session.supabase = {
  from: () => ({ select: () => ({ eq: () => ({ returns: async () => ({ data: h.itemRows, error: null }) }) }) }),
};

import { resetRateLimits } from "./rate-limit";
import { editPlanVersion, generatePlan, iteratePlan, loadPlanContext, loadPlanState, restoreVersion } from "./plan-pipeline";
import { applyPatch } from "@/lib/plan/patch";

const insertArg = () => h.insert.mock.calls[0] as unknown as [unknown, unknown, { input: Record<string, unknown>; inputHash: string }];
const TRIP = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
  h.budgetOk = true;
  h.lock = true;
  h.order = [];
  h.getFacts.mockImplementation(async () => {
    h.order.push("facts");
    return h.facts;
  });
  h.acquire.mockImplementation(async () => {
    h.order.push("lock");
    return h.lock ? "tok" : null;
  });
  h.ensure.mockImplementation(async () => h.planRow);
  h.inFlight = false;
  h.latest = stored("hash-old", 1);
  h.byHash = null;
  h.trip.lengthDays = 3;
  h.trip.access = "owner";
  h.trip.ownerId = "u1";
  h.trip.wantsFlights = undefined;
  h.ownerCtx = { birthdate: "1980-05-06", homeAirports: ["MUC"], locale: "en", displayName: "Alice" };
  h.planRow = { id: "plan1", latestVersion: 1, busyUntil: null };
  h.needsTags.mockReturnValue(false);
  h.facts = { places: { status: "unavailable", reason: "no_location" } };
  h.picks = [];
  h.itemRows = [];
  h.trip.destination = { kind: "city", lat: 36.5, lon: -4.9 };
  h.compose.mockResolvedValue({ ok: true, data: {}, usage: {} });
  h.assemble.mockReturnValue({ ok: true, plan: Plan, issues: {} });
});

describe("shared trips (sharing spec 1.1, 1.2, 3.5)", () => {
  const owner = (access: "write" | "read") => {
    h.trip.access = access;
    h.trip.ownerId = "owner-1";
  };
  const withLocale = (locale: string) => {
    h.latest = { ...stored("hash-old", 1), plan: { ...Plan, locale } };
  };

  it("a write grantee generates with the OWNER's birthdate, home airports and the language of the latest version", async () => {
    owner("write");
    withLocale("en");
    h.trip.wantsFlights = true;
    const res = await generatePlan(TRIP, "de"); // the grantee's request locale must not decide
    expect(res).toMatchObject({ ok: true });
    expect(h.build.mock.calls[0][0]).toMatchObject({ profileBirthdate: "1980-05-06", locale: "en" });
    expect(h.getFacts.mock.calls[0][2]).toMatchObject({ locale: "en", userId: "u1" });
    expect(h.getFacts.mock.calls[0][3]).toMatchObject({ withFlights: { homeAirports: ["MUC"] } });
    expect(h.compose).toHaveBeenCalledTimes(1);
    h.trip.wantsFlights = undefined;
  });

  it("the same input gives the same build arguments whoever presses the button (owner vs write grantee)", async () => {
    withLocale("en");
    h.trip.wantsFlights = true;
    h.ownerCtx = { birthdate: "1999-01-02", homeAirports: ["FRA"], locale: "en", displayName: null }; // = the owner's own profile
    await generatePlan(TRIP, "en"); // the owner themselves
    resetRateLimits();
    owner("write");
    await generatePlan(TRIP, "de"); // a grantee, other request locale
    const [own, shared] = h.build.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(shared.profileBirthdate).toBe(own.profileBirthdate);
    expect(shared.locale).toBe(own.locale);
    expect(h.getFacts.mock.calls[1][3]).toEqual(h.getFacts.mock.calls[0][3]);
    h.trip.wantsFlights = undefined;
  });

  it("a first plan on a shared trip takes the owner's locale", async () => {
    owner("write");
    h.planRow = { id: "plan1", latestVersion: 0, busyUntil: null };
    h.ensure.mockImplementation(async () => h.planRow);
    h.latest = null;
    await generatePlan(TRIP, "de");
    expect(h.build.mock.calls[0][0]).toMatchObject({ locale: "en" }); // ownerCtx.locale
  });

  it("the owner's request locale and own profile values are unchanged for the owner", async () => {
    await generatePlan(TRIP, "de");
    expect(h.build.mock.calls[0][0]).toMatchObject({ profileBirthdate: "1999-01-02", locale: "de" });
  });

  it("AI usage is charged to the acting user, not to the owner", async () => {
    owner("write");
    withLocale("en");
    h.compose.mockImplementation(async (_llm: unknown, ctx: { onUsage: (u: unknown) => Promise<void> }) => {
      await ctx.onUsage({ costMicroUsd: 7 });
      return { ok: true, data: {}, usage: {} };
    });
    await generatePlan(TRIP, "en");
    expect(h.logUsage).toHaveBeenCalledWith("u1", false, expect.objectContaining({ costMicroUsd: 7 }));
    expect(h.logUsage).not.toHaveBeenCalledWith("owner-1", expect.anything(), expect.anything());
  });

  it("the in-flight guard asks about the acting user's own runs", async () => {
    await generatePlan(TRIP, "en");
    expect(h.hasBusy).toHaveBeenCalledWith(expect.anything(), "u1");
  });

  it("a read grantee is forbidden on every write path, before any work", async () => {
    owner("read");
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "forbidden" });
    expect(await iteratePlan(TRIP, 1, { days: [1], text: "x" } as never, "en")).toMatchObject({ ok: false, error: "forbidden" });
    expect(await editPlanVersion(TRIP, 1, { kind: "set_best", n: null })).toMatchObject({ ok: false, error: "forbidden" });
    expect(await restoreVersion(TRIP, 1)).toMatchObject({ ok: false, error: "forbidden" });
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.patch).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.acquire).not.toHaveBeenCalled();
  });

  it("a read grantee can still load the plan context (the page reads it)", async () => {
    owner("read");
    expect(await loadPlanContext(TRIP)).toMatchObject({ ok: true, ctx: { access: "read", ownerId: "owner-1", birthdate: "1980-05-06" } });
  });

  it("fails closed when the owner's context cannot be read: never falls back to the grantee's own values", async () => {
    owner("write");
    h.ownerCtx = null;
    expect(await loadPlanContext(TRIP)).toMatchObject({ ok: false, error: "failed" });
    h.ownerCtx = { birthdate: "1980-05-06", homeAirports: ["MUC"], locale: "en", displayName: "Alice" };
  });

  it("the owner path never reads the owner context", async () => {
    h.ownerCtx = null; // would fail closed if it were read
    expect(await loadPlanContext(TRIP)).toMatchObject({ ok: true, ctx: { access: "owner", birthdate: "1999-01-02", homeAirports: ["FRA"] } });
    h.ownerCtx = { birthdate: "1980-05-06", homeAirports: ["MUC"], locale: "en", displayName: "Alice" };
  });
});

describe("busy guards", () => {
  it("generate: another plan in flight for the user -> busy, no AI", async () => {
    h.inFlight = true;
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "busy" });
    expect(h.compose).not.toHaveBeenCalled();
  });
  it("generate: dedupe path respects a busy plan", async () => {
    h.latest = stored("hash-new", 1);
    h.lock = false; // another run holds the lock
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

describe("places before the plan", () => {
  const errorGroup = { places: { status: "ok", data: { radiusKm: 40, groups: [{ interest: "golf", status: "error" }], customInterests: [] } } };
  it("places with a source still loading -> places_pending (retryable), no AI call", async () => {
    h.facts = errorGroup;
    const res = await generatePlan(TRIP, "en");
    expect(res).toMatchObject({ ok: false, error: "places_pending", retryAfter: 60 });
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });
  it("force generates anyway", async () => {
    h.facts = errorGroup;
    await generatePlan(TRIP, "en", { force: true });
    expect(h.compose).toHaveBeenCalledTimes(1);
  });
  it("empty groups and no_source are not pending", async () => {
    h.facts = { places: { status: "ok", data: { radiusKm: 40, groups: [{ interest: "golf", status: "empty", fetchedAt: "f", stale: false }, { interest: "cruise", status: "no_source" }], customInterests: [] } } };
    await generatePlan(TRIP, "en");
    expect(h.compose).toHaveBeenCalledTimes(1);
  });
  it("drive times for the selected places go into the input; ORS failure still generates", async () => {
    h.facts = { places: { status: "ok", data: { radiusKm: 40, groups: [], customInterests: [] } } };
    h.picks = [{ key: "way/1", c: { lat: 36.6, lon: -4.7 } }];
    const drive = { byKey: { "way/1": { min: 25, km: 21 } }, fetchedAt: "f" };
    h.drive.mockResolvedValueOnce(drive);
    await generatePlan(TRIP, "en");
    expect(h.drive).toHaveBeenCalledWith({ lat: 36.5, lon: -4.9 }, [{ key: "way/1", lat: 36.6, lon: -4.7 }], expect.anything());
    expect(h.build.mock.calls[0][0]).toMatchObject({ drive });
    h.drive.mockResolvedValueOnce(null);
    resetRateLimits();
    await generatePlan(TRIP, "en");
    expect(h.build.mock.calls[1][0]).toMatchObject({ drive: null });
    expect(h.compose).toHaveBeenCalledTimes(2);
  });
});

describe("one request does places and plan (server start)", () => {
  const errorGroup = { places: { status: "ok", data: { radiusKm: 40, groups: [{ interest: "golf", status: "error" }], customInterests: [] } } };
  it("the lock is taken before places are loaded (busy from the first second)", async () => {
    await generatePlan(TRIP, "en");
    expect(h.order).toEqual(["lock", "facts"]);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it("a second request while the first loads places gets busy and does no work", async () => {
    h.lock = false;
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "busy" });
    expect(h.getFacts).not.toHaveBeenCalled();
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled(); // never took it, must not free the other run's lock
  });
  it("another plan of the user in flight: busy before any lock or work", async () => {
    h.inFlight = true;
    await generatePlan(TRIP, "en");
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.getFacts).not.toHaveBeenCalled();
  });
  it("a trip without a plans row gets one before the lock", async () => {
    h.planRow = { id: "new-plan", latestVersion: 0, busyUntil: null };
    h.latest = null;
    await generatePlan(TRIP, "en");
    expect(h.ensure).toHaveBeenCalled();
    expect(h.acquire).toHaveBeenCalledWith(expect.anything(), "new-plan");
    expect(h.release).toHaveBeenCalledWith(expect.anything(), "new-plan", "tok");
    expect(h.compose).toHaveBeenCalledTimes(1);
  });
  it("loads places with the network budget; force reads the cache only", async () => {
    await generatePlan(TRIP, "en");
    expect(h.getFacts.mock.calls[0][3]).toMatchObject({ placesBudgetMs: 110_000 });
    resetRateLimits();
    await generatePlan(TRIP, "en", { force: true });
    expect(h.getFacts.mock.calls[1][3]).toMatchObject({ placesBudgetMs: 0 });
  });
  it("places failure: places_pending, lock released; the retry with force still generates", async () => {
    h.facts = errorGroup;
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "places_pending" });
    expect(h.release).toHaveBeenCalledTimes(1);
    resetRateLimits();
    expect(await generatePlan(TRIP, "en", { force: true })).toMatchObject({ ok: true });
    expect(h.compose).toHaveBeenCalledTimes(1);
  });
  it("pending + client gone: generates with what is cached, logs the path, releases the lock", async () => {
    h.facts = errorGroup;
    const clientGone = vi.fn(() => true);
    expect(await generatePlan(TRIP, "en", { clientGone })).toMatchObject({ ok: true });
    expect(clientGone).toHaveBeenCalledTimes(1);
    expect(h.compose).toHaveBeenCalledTimes(1);
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "plan.places_pending_generated", props: expect.objectContaining({ clientGone: true }) }));
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it("pending + client connected: places_pending, lock released", async () => {
    h.facts = errorGroup;
    expect(await generatePlan(TRIP, "en", { clientGone: () => false })).toMatchObject({ ok: false, error: "places_pending" });
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it("the client check is not spent when nothing is pending", async () => {
    const clientGone = vi.fn(() => true);
    await generatePlan(TRIP, "en", { clientGone });
    expect(clientGone).not.toHaveBeenCalled();
  });
  it("records the pending interests beside the input, never in it (hash and LLM input unchanged)", async () => {
    h.facts = errorGroup;
    await generatePlan(TRIP, "en", { force: true });
    const [, , v] = insertArg();
    const input = v.input;
    expect(input.pendingPlaces).toEqual(["golf"]);
    expect(input.llm).toEqual({ v: 1 });
    expect(v.inputHash).toBe("hash-new");
  });
  it("a version written without pending interests carries no note (later regenerate is clean)", async () => {
    await generatePlan(TRIP, "en", { fresh: true });
    expect(insertArg()[2].input).not.toHaveProperty("pendingPlaces");
  });
  it("the state flags an incomplete latest version only", async () => {
    const loaded = await loadPlanContext(TRIP);
    if (!loaded.ok) throw new Error("ctx");
    h.latest = { ...stored("h", 1), input: { llm: { v: 1 }, index: {}, pendingPlaces: ["golf"] } };
    const weak = await loadPlanState(loaded.ctx);
    expect(weak.ok && weak.state.placesIncomplete).toBe(true);
    h.latest = stored("h", 1);
    const clean = await loadPlanState(loaded.ctx);
    expect(clean.ok && clean.state.placesIncomplete).toBeUndefined();
  });
  it("regenerate (fresh) is not blocked by places that failed to load", async () => {
    h.facts = errorGroup;
    expect(await generatePlan(TRIP, "en", { fresh: true })).toMatchObject({ ok: true });
  });
  it("lock released when facts throw", async () => {
    h.getFacts.mockRejectedValue(new Error("boom"));
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "failed" });
    expect(h.release).toHaveBeenCalledWith(expect.anything(), "plan1", "tok");
  });
  it("lock released on the unchanged (dedupe) exit", async () => {
    h.latest = stored("hash-new", 1);
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: true, data: { unchanged: true } });
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it("ensurePlan failing leaves no lock to release", async () => {
    h.ensure.mockRejectedValue(new Error("db"));
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "failed" });
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
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
  it("budget exceeded: no AI call, and the early lock is released", async () => {
    h.budgetOk = false;
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "budget_exceeded", resetAt: "r" });
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledWith(expect.anything(), "plan1", "tok");
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
    expect(h.release).toHaveBeenCalledWith(expect.anything(), "plan1", "tok");
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
  it("trip items go into the input builder", async () => {
    h.itemRows = [ROW];
    await generatePlan(TRIP, "en");
    expect(h.build.mock.calls[0][0]).toMatchObject({ items: [{ id: "i1", day: 1, startTime: "07:50", endTime: "10:40", status: "booked" }] });
  });
  it("fresh (regenerate) skips the hash dedupe and calls the model", async () => {
    h.latest = stored("hash-new", 1);
    const res = await generatePlan(TRIP, "en", { fresh: true });
    expect(res.ok).toBe(true);
    expect(h.compose).toHaveBeenCalledTimes(1);
    expect(h.insert).toHaveBeenCalledWith(expect.anything(), "plan1", expect.objectContaining({ kind: "generate" }));
  });
  it("rate limits at 6 per minute", async () => {
    h.budgetOk = false;
    for (let i = 0; i < 6; i++) await generatePlan(TRIP, "en");
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "rate_limited" });
  });
});

const ROW = { id: "i1", trip_id: TRIP, category: "flight", title: "LH 1150 FRA → AGP", status: "booked", price_cents: null, price_basis: "total", persons: null, currency: "EUR", day: 1, ref: null, url: null, notes: null, start_time: "07:50", end_time: "10:40", created_at: "c", updated_at: "u" };

describe("iteratePlan", () => {
  it("sends the current fixed items to the patch and to applyPatch", async () => {
    h.itemRows = [ROW];
    h.patch.mockResolvedValue({ ok: true, data: { reply: "r", days: [] }, usage: {} });
    vi.mocked(applyPatch).mockReturnValue({ ok: true, plan: Plan, changedDays: [], issues: {} } as never);
    await iteratePlan(TRIP, 1, { chips: ["more_rest"], days: [1] }, "en");
    const fixed = [{ day: 1, from: "07:50", to: "10:40", cat: "flight" }];
    expect(h.patch.mock.calls[0][0]).toMatchObject({ fixed });
    expect(vi.mocked(applyPatch).mock.calls[0][0]).toMatchObject({ fixed });
  });
  it("shrink guard: a stub day is not saved, the rejection is logged and returned (patch-safety [D3])", async () => {
    const acts = (k: number) => Array.from({ length: k }, (_, i) => ({ kind: "do", text: `a${i}` }));
    const day = (n: number, k: number) => ({ n, date: null, title: `T${n}`, stops: [{ place: "X", acts: acts(k) }], note: "Tipp" });
    const basePlan = { ...Plan, days: [day(1, 6), day(2, 3), day(3, 3)], places: {} };
    h.latest = { ...stored("hash-old", 1), plan: basePlan };
    h.patch.mockResolvedValue({ ok: true, data: { reply: "Tag 1 angepasst", days: [] }, usage: {} });
    const next = { ...basePlan, days: [{ ...day(1, 2), note: undefined }, basePlan.days[1], basePlan.days[2]] };
    vi.mocked(applyPatch).mockReturnValue({ ok: true, plan: next, changedDays: [1], issues: {} } as never);
    const r = await iteratePlan(TRIP, 1, { chips: [], days: [], text: "Amagertorv streichen" }, "de");
    expect(r).toMatchObject({ ok: true, data: { unchanged: true, rejectedDays: [1] } });
    expect(r.ok && r.data.reply).toBeFalsy();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "plan.patch_shrink_rejected", props: expect.objectContaining({ days: "1", actsBefore: 6, actsAfter: 2 }) }),
    );
  });
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

describe("iteratePlan: change requests that need places (activities spec section 4)", () => {
  const T = "2026-11-06T00:00:00.000Z";
  const escape = { types: ["escape_game"], group: "indoor", osmType: "node", osmId: 7, name: "Exit Room", names: {}, category: "leisure=escape_game", lat: 49.79, lon: 9.93, distanceKm: 1.2, osmUrl: "https://www.openstreetmap.org/node/7" };
  const indoorOk = { activities: [{ group: "indoor", status: "ok", places: [escape], fetchedAt: T }] };
  const ask = { ok: true, data: { reply: "lade", days: [], needPlaces: { types: ["escape_game"] } }, usage: {} };
  const answer = { ok: true, data: { reply: "Escape Room an Tag 1", days: [{ n: 1 }] }, usage: {} };
  const day = (n: number, text: string) => ({ n, date: null, title: `T${n}`, stops: [{ place: "X", acts: [{ kind: "do", text }] }] });
  const basePlan = { ...Plan, days: [day(1, "a"), day(2, "b"), day(3, "c")], places: {} };
  beforeEach(() => {
    h.latest = { ...stored("hash-old", 1), plan: basePlan };
    vi.mocked(applyPatch).mockReturnValue({ ok: true, plan: { ...basePlan, days: [day(1, "Escape Room"), basePlan.days[1], basePlan.days[2]] }, changedDays: [1], issues: {} } as never);
    h.lookups.mockResolvedValue(indoorOk);
  });

  it("loads the places, patches once more with loaded, stores the extended input with the base hash", async () => {
    h.patch.mockResolvedValueOnce(ask).mockResolvedValueOnce(answer);
    const r = await iteratePlan(TRIP, 1, { chips: [], days: [1], text: "konkrete Escape Rooms" }, "de");
    expect(r).toMatchObject({ ok: true, data: { reply: "Escape Room an Tag 1" } });
    expect(h.lookups).toHaveBeenCalledWith(h.trip.destination, { groups: ["indoor"], restaurants: false, cafes: false }, expect.anything(), 60_000);
    expect(h.patch).toHaveBeenCalledTimes(2);
    const second = h.patch.mock.calls[1][0] as { loaded: boolean; timeoutMs: number; llm: { activities: { wishes: { w: string }[] } }; index: Record<string, unknown> };
    expect(second.loaded).toBe(true);
    expect(second.timeoutMs).toBeGreaterThan(200_000);
    expect(second.llm.activities.wishes[0].w).toBe("FEEDBACK");
    expect(second.index.a1).toBeDefined();
    expect(vi.mocked(applyPatch).mock.calls[0][0]).toMatchObject({ patch: answer.data, stored: { index: { a1: expect.anything() } } });
    // Base hash like every patch (a later Generate never matches a patched plan); the extended input is kept.
    expect(insertArg()[2]).toMatchObject({ inputHash: "hash-old", input: { index: { a1: expect.anything() } } });
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "plan.patch_need_places", props: expect.objectContaining({ types: "escape_game" }) }));
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("no needPlaces: one call, the base input and hash are kept", async () => {
    h.patch.mockResolvedValueOnce(answer);
    await iteratePlan(TRIP, 1, { chips: ["more_rest"], days: [1] }, "de");
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.lookups).not.toHaveBeenCalled();
    expect(insertArg()[2]).toMatchObject({ inputHash: "hash-old", input: { llm: { v: 1 }, index: {} } });
  });

  it("places that fail to load: places_pending, no new version, warming continues after the response", async () => {
    h.patch.mockResolvedValueOnce(ask);
    h.lookups.mockResolvedValue({ activities: [{ group: "indoor", status: "error", places: [] }] });
    const r = await iteratePlan(TRIP, 1, { chips: [], days: [1], text: "Escape Rooms" }, "de");
    expect(r).toMatchObject({ ok: false, error: "places_pending", retryAfter: 60 });
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.warm).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("a cache-only miss (skipped) is pending too; restaurants near a place load around it", async () => {
    h.latest = { ...stored("hash-old", 1), plan: basePlan, input: { llm: { v: 1 }, index: { a3: { key: "node/9", place: { lat: 49.7, lon: 9.8 } } } } };
    h.patch.mockResolvedValueOnce({ ok: true, data: { reply: "x", days: [], needPlaces: { restaurants: { near: "a3" } } }, usage: {} });
    h.lookups.mockResolvedValue({ activities: [], restaurants: { status: "skipped", reason: "cache_only", restaurants: [] } });
    const r = await iteratePlan(TRIP, 1, { chips: [], days: [1], text: "Restaurant beim Klettern" }, "de");
    expect(r).toMatchObject({ ok: false, error: "places_pending" });
    expect(h.lookups.mock.calls[0][1]).toEqual({ groups: [], restaurants: { near: { lat: 49.7, lon: 9.8 } }, cafes: false });
  });

  it("cafés (addendum A2): loaded only on request, near a place, pending like restaurants when they fail", async () => {
    h.latest = { ...stored("hash-old", 1), plan: basePlan, input: { llm: { v: 1 }, index: { a3: { key: "node/9", place: { lat: 49.7, lon: 9.8 } } } } };
    h.patch.mockResolvedValueOnce({ ok: true, data: { reply: "x", days: [], needPlaces: { cafes: { near: "a3", kids: true } } }, usage: {} });
    h.lookups.mockResolvedValue({ activities: [], cafes: { status: "error", cafes: [] } });
    const r = await iteratePlan(TRIP, 1, { chips: [], days: [1], text: "kinderfreundliches Café beim Spielplatz" }, "de");
    expect(r).toMatchObject({ ok: false, error: "places_pending" });
    expect(h.lookups.mock.calls[0][1]).toEqual({ groups: [], restaurants: false, cafes: { near: { lat: 49.7, lon: 9.8 } } });
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "plan.patch_need_places", props: expect.objectContaining({ cafes: true }) }));
  });

  it("too little time left for the second call: places_pending, no second call", async () => {
    const now = Date.now();
    h.patch.mockResolvedValueOnce(ask);
    h.lookups.mockImplementation(async () => {
      vi.spyOn(Date, "now").mockReturnValue(now + 200_000);
      return indoorOk;
    });
    const r = await iteratePlan(TRIP, 1, { chips: [], days: [1], text: "Escape Rooms" }, "de");
    vi.restoreAllMocks();
    expect(r).toMatchObject({ ok: false, error: "places_pending" });
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("budget is checked again before the second call", async () => {
    h.patch.mockImplementationOnce(async () => {
      h.budgetOk = false;
      return ask;
    });
    const r = await iteratePlan(TRIP, 1, { chips: [], days: [1], text: "Escape Rooms" }, "de");
    expect(r).toMatchObject({ ok: false, error: "budget_exceeded" });
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("an unloadable request (unknown types only) keeps the first answer", async () => {
    h.patch.mockResolvedValueOnce({ ok: true, data: { reply: "nichts", days: [] }, usage: {} });
    await iteratePlan(TRIP, 1, { chips: [], days: [1], text: "x" }, "de");
    expect(h.lookups).not.toHaveBeenCalled();
  });
});

describe("activities and restaurants before the plan (QA)", () => {
  const okPlaces = { status: "ok", data: { radiusKm: 15, groups: [], customInterests: [] } };
  it("a failed activity group or restaurant lookup is pending: places_pending, no AI call", async () => {
    h.facts = { places: okPlaces, activities: [{ group: "indoor", status: "error", places: [] }], restaurants: { status: "ok", restaurants: [] } };
    expect(await generatePlan(TRIP, "de")).toMatchObject({ ok: false, error: "places_pending", retryAfter: 60 });
    h.facts = { places: okPlaces, restaurants: { status: "error", restaurants: [] } };
    resetRateLimits();
    expect(await generatePlan(TRIP, "de")).toMatchObject({ ok: false, error: "places_pending" });
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "plan.places_pending", props: expect.objectContaining({ interests: "restaurants" }) }));
  });
  it("a lookup skipped because the shared budget ran out (cache_only) is pending like error", async () => {
    h.facts = { places: okPlaces, activities: [{ group: "outdoor", status: "skipped", reason: "cache_only", places: [] }], restaurants: { status: "ok", restaurants: [] } };
    expect(await generatePlan(TRIP, "de")).toMatchObject({ ok: false, error: "places_pending" });
    expect(h.compose).not.toHaveBeenCalled();
  });
  it("free-text destination (skipped: no_location) and force pass through", async () => {
    h.facts = { places: okPlaces, restaurants: { status: "skipped", reason: "no_location", restaurants: [] } };
    await generatePlan(TRIP, "de");
    expect(h.compose).toHaveBeenCalledTimes(1);
    h.facts = { places: okPlaces, activities: [{ group: "outdoor", status: "skipped", reason: "cache_only", places: [] }] };
    resetRateLimits();
    await generatePlan(TRIP, "de", { force: true });
    expect(h.compose).toHaveBeenCalledTimes(2);
  });
});

describe("iteratePlan: needPlaces edges (QA)", () => {
  const day = (n: number, text: string) => ({ n, date: null, title: `T${n}`, stops: [{ place: "X", acts: [{ kind: "do", text }] }] });
  const basePlan = { ...Plan, days: [day(1, "a"), day(2, "b"), day(3, "c")], places: {} };
  const escape = { types: ["escape_game"], group: "indoor", osmType: "node", osmId: 7, name: "Exit Room", names: {}, category: "leisure=escape_game", lat: 49.79, lon: 9.93, distanceKm: 1.2, osmUrl: "https://www.openstreetmap.org/node/7" };
  const ask = { ok: true, data: { reply: "lade", days: [], needPlaces: { types: ["escape_game"] } }, usage: {} };
  const billed = (r: unknown) => async (_a: unknown, ctx: { onUsage: (u: unknown) => Promise<void> }) => {
    await ctx.onUsage({ task: "plan_patch", costMicroUsd: 5000 });
    return r;
  };
  beforeEach(() => {
    h.latest = { ...stored("hash-old", 1), plan: basePlan };
    h.lookups.mockResolvedValue({ activities: [{ group: "indoor", status: "ok", places: [escape], fetchedAt: "f" }] });
    vi.mocked(applyPatch).mockReturnValue({ ok: true, plan: { ...basePlan, days: [day(1, "Escape Room"), basePlan.days[1], basePlan.days[2]] }, changedDays: [1], issues: {} } as never);
  });

  it("unusable needPlaces with no days: unchanged with a fixed notice, never the model's reply", async () => {
    h.patch.mockResolvedValueOnce({ ok: true, data: { reply: "Ich lade sie jetzt", days: [], needPlacesUnusable: true }, usage: {} });
    const r = await iteratePlan(TRIP, 1, { chips: [], days: [1], text: "Laser Maze" }, "de");
    expect(r).toMatchObject({ ok: true, data: { unchanged: true, notice: "places_not_loadable" } });
    expect(r.ok && r.data.reply).toBeFalsy();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.lookups).not.toHaveBeenCalled();
  });

  it("second call asks again without days: unchanged with the notice, no version", async () => {
    h.patch.mockResolvedValueOnce(ask).mockResolvedValueOnce({ ok: true, data: { reply: "lade noch mehr", days: [], needPlacesUnusable: true }, usage: {} });
    const r = await iteratePlan(TRIP, 1, { chips: [], days: [1], text: "Escape Rooms" }, "de");
    expect(r).toMatchObject({ ok: true, data: { unchanged: true, notice: "places_not_loadable" } });
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("second-call failure: both calls billed, lock released, no version", async () => {
    h.patch.mockImplementationOnce(billed(ask)).mockImplementationOnce(billed({ ok: false, error: "ai_unavailable" }));
    const r = await iteratePlan(TRIP, 1, { chips: [], days: [1], text: "Escape Rooms" }, "de");
    expect(r).toMatchObject({ ok: false, error: "ai_unavailable" });
    expect(h.logUsage).toHaveBeenCalledTimes(2);
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("a write grantee's needPlaces request bills the acting user for both calls", async () => {
    h.trip.access = "write";
    h.trip.ownerId = "owner-1";
    h.patch.mockImplementationOnce(billed(ask)).mockImplementationOnce(billed({ ok: true, data: { reply: "ok", days: [{ n: 1 }] }, usage: {} }));
    await iteratePlan(TRIP, 1, { chips: [], days: [1], text: "Escape Rooms" }, "de");
    expect(h.logUsage).toHaveBeenCalledTimes(2);
    for (const call of h.logUsage.mock.calls as unknown as unknown[][]) expect(call[0]).toBe("u1");
  });

  it("deadline boundary: exactly 120 s left still runs the second call, 1 ms less answers places_pending", async () => {
    for (const [extra, calls] of [[150_000, 2], [150_001, 1]] as const) {
      vi.clearAllMocks();
      resetRateLimits();
      h.lookups.mockResolvedValue({ activities: [{ group: "indoor", status: "ok", places: [escape], fetchedAt: "f" }] });
      vi.mocked(applyPatch).mockReturnValue({ ok: true, plan: { ...basePlan, days: [day(1, "Escape Room"), basePlan.days[1], basePlan.days[2]] }, changedDays: [1], issues: {} } as never);
      const t0 = 1_900_000_000_000;
      const now = vi.spyOn(Date, "now").mockReturnValue(t0);
      h.lookups.mockImplementationOnce(async () => {
        now.mockReturnValue(t0 + extra);
        return { activities: [{ group: "indoor", status: "ok", places: [escape], fetchedAt: "f" }] };
      });
      h.patch.mockResolvedValueOnce(ask).mockResolvedValueOnce({ ok: true, data: { reply: "ok", days: [{ n: 1 }] }, usage: {} });
      const r = await iteratePlan(TRIP, 1, { chips: [], days: [1], text: "Escape Rooms" }, "de");
      now.mockRestore();
      expect(h.patch).toHaveBeenCalledTimes(calls);
      if (calls === 2) expect((h.patch.mock.calls[1][0] as { timeoutMs: number }).timeoutMs).toBe(110_000);
      else expect(r).toMatchObject({ ok: false, error: "places_pending" });
    }
  });
});

describe("review: money and lock edges of the early lock", () => {
  it("tag budget blocked: no Haiku call, no facts, lock released", async () => {
    h.needsTags.mockReturnValue(true);
    h.budgetOk = false;
    expect(await generatePlan(TRIP, "en")).toMatchObject({ ok: false, error: "budget_exceeded" });
    expect(h.tag).not.toHaveBeenCalled();
    expect(h.getFacts).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it("identical input after pending + client gone is still a hash hit: no model call", async () => {
    h.facts = { places: { status: "ok", data: { radiusKm: 40, groups: [{ interest: "golf", status: "error" }], customInterests: [] } } };
    h.latest = stored("hash-new", 1);
    const res = await generatePlan(TRIP, "en", { clientGone: () => true });
    expect(res).toMatchObject({ ok: true });
    expect(h.compose).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});
