import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  session: { userId: "u1", supabase: {} } as { userId: string; supabase: unknown } | null,
  profile: { role: "user", isDemo: false, locale: "de", birthdate: null, homeAirports: ["FRA", "MUC", "HAM"] } as Record<string, unknown>,
  purpose: { id: "11111111-1111-4111-8111-111111111111", name: "Golf", guided: { interests: ["golf"] }, constraints: [], tags: null, updatedAt: "t" } as Record<string, unknown>,
  group: null as unknown,
  env: { AI_ENABLED: "true", ANTHROPIC_API_KEY: "k" } as Record<string, string>,
  budgetOk: true,
  runs: 0,
  runsError: false,
  wantsTags: false,
  tagAndSave: vi.fn(),
  byHash: vi.fn(),
  byId: vi.fn(),
  claim1: vi.fn(),
  claim2: vi.fn(),
  finish: vi.fn(),
  failRound: vi.fn(async () => {}),
  prune: vi.fn(async () => {}),
  propose: vi.fn(),
  verify: vi.fn(),
  logEvent: vi.fn(async () => {}),
  logUsage: vi.fn(async () => {}),
  budgetReserve: [] as number[],
  orsLeft: 400,
  placeById: vi.fn(),
  profileUpdate: vi.fn(async () => ({ error: null })),
}));

vi.mock("../session", () => ({ getUserSession: async () => h.session }));
vi.mock("../profile", () => ({ getProfile: async () => ({ ok: true, data: h.profile }) }));
vi.mock("../purposes", () => ({ getPurpose: async () => (h.purpose ? { ok: true, data: h.purpose } : { ok: false, error: "not_found" }) }));
vi.mock("../groups", () => ({ getGroup: async () => (h.group ? { ok: true, data: h.group } : { ok: false, error: "not_found" }) }));
vi.mock("../settings", () => ({ getEffectiveEnv: async () => h.env }));
vi.mock("../events", () => ({ logEvent: h.logEvent }));
vi.mock("../facts/ors-quota", () => ({ orsRequestsLeft: async () => h.orsLeft }));
vi.mock("@/lib/integrations/open-meteo-geocoding", () => ({ getPlaceById: h.placeById }));
vi.mock("../purpose-tagging", () => ({ wantsTags: () => h.wantsTags, tagAndSave: h.tagAndSave }));
vi.mock("../ai/destination-ideas", () => ({ proposeIdeas: h.propose }));
vi.mock("./verify", () => ({ verifyIdeas: h.verify }));
vi.mock("../ai-usage", async (orig) => {
  const m = await orig<typeof import("../ai-usage")>();
  return {
    ...m,
    logAiUsage: h.logUsage,
    getBudgetStatus: async () => {
      const cap = 500_000;
      return { spentMicroUsd: h.budgetOk ? 0 : cap, capMicroUsd: cap, resetsAt: "reset", globalSpentMicroUsd: 0, globalCapMicroUsd: 5_000_000 };
    },
  };
});
vi.mock("./store", async (orig) => {
  const m = await orig<typeof import("./store")>();
  return {
    ...m,
    getSearchByHash: h.byHash,
    getSearchById: h.byId,
    claimRound1: h.claim1,
    claimRound2: h.claim2,
    finishRound: h.finish,
    failRound: h.failRound,
    pruneSearches: h.prune,
    countRunsToday: async () => {
      if (h.runsError) throw new Error("read failed");
      return h.runs;
    },
  };
});

import { resetRateLimits } from "../rate-limit";
import type { StoredSearch } from "./store";
import { DAILY_RUNS, getDestinationSearch, resolveSearchParams, RESERVE_IDEAS, runDestinationSearch, showOtherDestinations } from "./pipeline";

const PURPOSE = "11111111-1111-4111-8111-111111111111";
const SEARCH = "33333333-3333-4333-8333-333333333333";
const body = { purposeId: PURPOSE, months: [3] };

const stored = (o: Partial<StoredSearch> = {}): StoredSearch => ({
  id: SEARCH,
  purposeId: PURPOSE,
  groupId: null,
  purposeName: "Golf",
  locale: "de",
  months: [3],
  origins: ["FRA", "MUC"],
  travelMode: "flight",
  maxFlightHours: null,
  maxDriveHours: null,
  homeName: null,
  radiusKm: null,
  status: "done",
  rounds: 1,
  cards: [],
  drops: {},
  error: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  inputHash: "a".repeat(64),
  input: { v: 1, lang: "de", purpose: { interests: ["golf"], custom: [], hard: [], soft: [] }, count: 8, exclude: ["Marbella", "Palma"] },
  busyUntil: null,
  costMicroUsd: 400,
  homeLat: null,
  homeLon: null,
  ...o,
});
const card = (geoId: number) => ({ id: `g${geoId}`, round: 1 as const, name: "X", reason: null, kind: "city" as const, geoId, placeName: "X", countryCode: "ES", admin1: null, place: { source: "geonames" as const, fetchedAt: "t", stale: false }, flight: null, nearAirport: false, climate: null, pois: [] });
const idea = (anchor: string) => ({ name: anchor, anchor, cc: "ES", reason: "r" });

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
  h.session = { userId: "u1", supabase: {} };
  h.profile = { role: "user", isDemo: false, locale: "de", birthdate: null, homeAirports: ["FRA", "MUC", "HAM"] };
  h.purpose = { id: PURPOSE, name: "Golf", guided: { interests: ["golf"] }, constraints: [], tags: null, updatedAt: "t" };
  h.group = null;
  h.env = { AI_ENABLED: "true", ANTHROPIC_API_KEY: "k" };
  h.budgetOk = true;
  h.runs = 0;
  h.runsError = false;
  h.wantsTags = false;
  h.byHash.mockResolvedValue(null);
  h.byId.mockResolvedValue(stored());
  // the claimed row reflects what was inserted
  h.claim1.mockImplementation(async (_sb: unknown, n: { months: number[]; origins: string[]; maxFlightHours: number | null; radiusKm: number | null }) => ({
    ok: true,
    search: stored({ status: "running", months: n.months, origins: n.origins, maxFlightHours: n.maxFlightHours, radiusKm: n.radiusKm }),
  }));
  h.claim2.mockImplementation(async () => ({ ok: true, search: stored({ status: "running" }) }));
  h.finish.mockImplementation(async (_sb: unknown, _id: string, p: { cards: unknown[] }) => stored({ cards: p.cards as never, rounds: 1 }));
  h.propose.mockResolvedValue({ ok: true, data: [idea("Marbella"), idea("Palma")], usage: {} });
  h.verify.mockResolvedValue({ cards: [card(1)], drops: { too_far: 1 }, reasonsRemoved: 1, geocodeDown: false, stoppedBy: null, climateMisses: 1 });
});

describe("gates, in the order of the spec", () => {
  it("1. no session -> unauthenticated; bad input -> invalid (with issues); unknown purpose -> not_found", async () => {
    h.session = null;
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "unauthenticated" });
    h.session = { userId: "u1", supabase: {} };
    expect(await runDestinationSearch({ purposeId: "nope" })).toMatchObject({ ok: false, error: "invalid" });
    expect(await runDestinationSearch({ ...body, months: [1, 2, 3, 4] })).toMatchObject({ ok: false, error: "invalid" });
    expect(await runDestinationSearch({ ...body, origins: ["frankfurt"] })).toMatchObject({ ok: false, error: "invalid" });
    h.purpose = null as never;
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "not_found" });
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("2. a saved list for the same input costs nothing and works with AI switched off (no gate after it runs)", async () => {
    h.env = { AI_ENABLED: "false" };
    h.runs = 99;
    h.budgetOk = false;
    h.byHash.mockResolvedValue(stored({ cards: [card(1)] }));
    const r = await runDestinationSearch(body);
    expect(r).toMatchObject({ ok: true, data: { id: SEARCH, cached: true, aiEnabled: false, canShowOthers: false } });
    expect(h.propose).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.claim1).not.toHaveBeenCalled();
    expect(h.logUsage).not.toHaveBeenCalled();
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "destination.searched", props: expect.objectContaining({ cached: true, cards: 1 }) }));
  });

  it("2. a cached hit does not consume the one-run-per-minute limit", async () => {
    h.byHash.mockResolvedValue(stored());
    await runDestinationSearch(body);
    await runDestinationSearch(body);
    h.byHash.mockResolvedValue(null);
    expect(await runDestinationSearch(body)).toMatchObject({ ok: true });
  });

  it("2. a list older than 30 days is not served: the row is reused for a new run", async () => {
    h.byHash.mockResolvedValue(stored({ updatedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() }));
    const r = await runDestinationSearch(body);
    expect(r).toMatchObject({ ok: true });
    expect(h.claim1).toHaveBeenCalledWith(expect.anything(), expect.anything(), SEARCH);
  });

  it("2. a failed list is reused in place; a list still running is returned as it is (the page polls)", async () => {
    h.byHash.mockResolvedValue(stored({ status: "failed", error: "ai_unavailable" }));
    await runDestinationSearch(body);
    expect(h.claim1).toHaveBeenCalledWith(expect.anything(), expect.anything(), SEARCH);
    h.claim1.mockClear();
    resetRateLimits();
    h.byHash.mockResolvedValue(stored({ status: "running" }));
    expect(await runDestinationSearch(body)).toMatchObject({ ok: true, data: { status: "running", cached: true } });
    expect(h.claim1).not.toHaveBeenCalled();
  });

  it("3. AI off and nothing saved -> ai_disabled", async () => {
    h.env = { AI_ENABLED: "false" };
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "ai_disabled" });
    h.env = { AI_ENABLED: "true" }; // no API key
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "ai_disabled" });
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("4. one real run per minute", async () => {
    await runDestinationSearch(body); // a real run takes the slot
    const r = await runDestinationSearch(body);
    expect(r).toMatchObject({ ok: false, error: "rate_limited" });
    expect((r as { retryAfter?: number }).retryAfter).toBeGreaterThan(0);
  });

  it("4. the slot is taken only after budget and claim passed: busy or budget_exceeded do not block the next minute", async () => {
    h.claim1.mockResolvedValueOnce({ ok: false, reason: "busy" });
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "busy" });
    h.budgetOk = false;
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "budget_exceeded" });
    h.budgetOk = true;
    expect(await runDestinationSearch(body)).toMatchObject({ ok: true }); // not rate_limited
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "rate_limited" });
  });

  it("5. daily runs: 10 users, 30 admin, 5 demo; search_limit carries resetAt", async () => {
    h.runs = DAILY_RUNS.user;
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "search_limit", resetAt: expect.any(String) });
    expect(DAILY_RUNS).toEqual({ user: 10, admin: 30, demo: 5 });
    h.runs = 9;
    resetRateLimits();
    expect(await runDestinationSearch(body)).toMatchObject({ ok: true });

    h.profile = { ...h.profile, role: "admin" };
    h.runs = 29;
    resetRateLimits();
    expect(await runDestinationSearch(body)).toMatchObject({ ok: true });
    h.runs = 30;
    resetRateLimits();
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "search_limit" });

    h.profile = { ...h.profile, role: "user", isDemo: true };
    h.runs = 4;
    resetRateLimits();
    expect(await runDestinationSearch(body)).toMatchObject({ ok: true });
    h.runs = 5;
    resetRateLimits();
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "search_limit" });
  });

  it("5. an unreadable usage log fails closed", async () => {
    h.runsError = true;
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "failed" });
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("6. budget exhausted -> budget_exceeded with resetAt, no call", async () => {
    h.budgetOk = false;
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "budget_exceeded", resetAt: "reset" });
    expect(h.propose).not.toHaveBeenCalled();
    expect(h.claim1).not.toHaveBeenCalled();
    expect(RESERVE_IDEAS).toBe(20_000);
  });

  it("7. another running search of the user -> busy, no call", async () => {
    h.claim1.mockResolvedValue({ ok: false, reason: "busy" });
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "busy" });
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("7. an identical search that started meanwhile is returned instead of failing", async () => {
    h.claim1.mockResolvedValue({ ok: false, reason: "exists" });
    h.byHash.mockResolvedValueOnce(null).mockResolvedValueOnce(stored({ status: "running" }));
    expect(await runDestinationSearch(body)).toMatchObject({ ok: true, data: { status: "running", cached: true } });
  });
});

describe("a real run", () => {
  it("one call, verification, save, prune; the stored input keeps the anchors of ALL ideas for 'Show others'", async () => {
    const r = await runDestinationSearch({ ...body, origins: ["FRA"], maxFlightHours: 3 });
    expect(r).toMatchObject({ ok: true, data: { id: SEARCH, status: "done" } });
    if (r.ok) expect(r.data.cached).toBeUndefined();
    expect(h.propose).toHaveBeenCalledTimes(1);
    const sent = h.propose.mock.calls[0][0];
    expect(sent).toMatchObject({ lang: "de", months: [3], from: ["Frankfurt am Main"], radiusKm: 2128, count: 8 });
    expect(sent.exclude).toBeUndefined();
    const v = h.verify.mock.calls[0][0];
    expect(v).toMatchObject({ round: 1, origins: ["FRA"], maxHours: 3, months: [3], interests: ["golf"], existing: [] });
    const fin = h.finish.mock.calls[0][2];
    expect(fin).toMatchObject({ round: 1, drops: { too_far: 1 } });
    expect(fin.input.exclude).toEqual(["Marbella", "Palma"]);
    expect(h.prune).toHaveBeenCalledTimes(1);
    const claim = h.claim1.mock.calls[0][1];
    expect(claim).toMatchObject({ locale: "de", months: [3], origins: ["FRA"], maxFlightHours: 3, radiusKm: 2128, model: "claude-haiku-5-5" });
    expect(claim.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "destination.searched", props: expect.objectContaining({ cards: 1, drops: 1, dropsDetail: "too_far:1", rounds: 1, cached: false, reasonsRemoved: 1 }) }),
    );
  });

  it("defaults: airports = first two of the profile, limit = the purpose's, passed to the model as a radius only", async () => {
    h.purpose = { ...h.purpose, guided: { interests: ["golf"], maxFlightHours: 2.5 } };
    await runDestinationSearch(body);
    expect(h.claim1.mock.calls[0][1]).toMatchObject({ origins: ["FRA", "MUC"], maxFlightHours: 2.5, radiusKm: 1729 });
    expect(h.propose.mock.calls[0][0].radiusKm).toBe(1729);
  });

  it("E8: a limit written in the purpose text is applied by code and absent from the model input", async () => {
    h.purpose = { ...h.purpose, constraints: ["max 3 h flight from FRA", "golf every day"] };
    await runDestinationSearch(body);
    expect(h.claim1.mock.calls[0][1]).toMatchObject({ maxFlightHours: 3, radiusKm: 2128 });
    expect(h.propose.mock.calls[0][0].purpose.hard).toEqual(["golf every day"]);
    expect(h.verify.mock.calls[0][0].maxHours).toBe(3);
  });

  it("all ideas dropped: done with 0 cards and the counts, no error, no place names", async () => {
    h.verify.mockResolvedValue({ cards: [], drops: { too_far: 5, climate: 2 }, reasonsRemoved: 0, geocodeDown: false, stoppedBy: null, climateMisses: 0 });
    const r = await runDestinationSearch(body);
    expect(r).toMatchObject({ ok: true, data: { status: "done", cards: [] } });
    expect(h.finish.mock.calls[0][2].drops).toEqual({ too_far: 5, climate: 2 });
    expect(h.failRound).not.toHaveBeenCalled();
    expect(JSON.stringify(h.finish.mock.calls[0][2].drops)).not.toMatch(/Marbella|Palma/);
  });

  it("no valid idea in the output: as all dropped, verification is skipped", async () => {
    h.propose.mockResolvedValue({ ok: true, data: [], usage: {} });
    const r = await runDestinationSearch(body);
    expect(r).toMatchObject({ ok: true, data: { status: "done", cards: [] } });
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("LLM error: the row is failed (cost logged by the client), the error is returned, an event is written", async () => {
    h.propose.mockResolvedValue({ ok: false, error: "ai_unavailable" });
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "ai_unavailable" });
    expect(h.failRound).toHaveBeenCalledWith(expect.anything(), SEARCH, expect.objectContaining({ round: 1, error: "ai_unavailable", previous: null }));
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "destination.search_failed", props: expect.objectContaining({ reason: "ai_unavailable" }) }));
  });

  it("refusal and invalid output map to their own errors", async () => {
    h.propose.mockResolvedValue({ ok: false, error: "ai_refused" });
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "ai_refused" });
    resetRateLimits();
    h.propose.mockResolvedValue({ ok: false, error: "invalid_output" });
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "invalid_output" });
  });

  it("geocoding down: failed with places_unavailable, nothing unverified is saved as a card", async () => {
    h.verify.mockResolvedValue({ cards: [], drops: {}, reasonsRemoved: 0, geocodeDown: true, stoppedBy: null, climateMisses: 0 });
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "places_unavailable" });
    expect(h.failRound).toHaveBeenCalledWith(expect.anything(), SEARCH, expect.objectContaining({ error: "places_unavailable" }));
    expect(h.finish).not.toHaveBeenCalled();
  });

  it("an exception during the run leaves the row not running", async () => {
    h.verify.mockRejectedValue(new Error("boom"));
    expect(await runDestinationSearch(body)).toMatchObject({ ok: false, error: "failed" });
    expect(h.failRound).toHaveBeenCalledWith(expect.anything(), SEARCH, expect.objectContaining({ error: "failed" }));
  });

  it("tagging first (hash covers the tags): budget includes the tag reserve, the saved lists are checked again", async () => {
    h.wantsTags = true;
    const tagged = { ...h.purpose, tags: { v: 1, interests: ["golf"], custom: [], hard: [], soft: [], summary: "Golf" } };
    h.tagAndSave.mockResolvedValue(tagged);
    h.byHash.mockResolvedValueOnce(null).mockResolvedValueOnce(stored({ cards: [card(7)] }));
    const r = await runDestinationSearch(body);
    expect(h.tagAndSave).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, data: { cached: true } });
    expect(h.byHash).toHaveBeenCalledTimes(2);
    expect(h.propose).not.toHaveBeenCalled();
  });
});

describe("resolveSearchParams (D1)", () => {
  const purpose = (guided: object = {}, constraints: string[] = []) => ({ guided, constraints }) as never;
  it("absent origins = first two of the profile; empty = none; explicit list wins", () => {
    expect(resolveSearchParams({}, purpose(), ["FRA", "MUC", "HAM"])).toMatchObject({ ok: true, origins: ["FRA", "MUC"] });
    expect(resolveSearchParams({ origins: [] }, purpose(), ["FRA"])).toMatchObject({ ok: true, origins: [] });
    expect(resolveSearchParams({ origins: ["HAM"] }, purpose(), ["FRA"])).toMatchObject({ ok: true, origins: ["HAM"] });
  });
  it("absent limit = the purpose's (guided field, else the text regex); null = none; explicit wins", () => {
    expect(resolveSearchParams({}, purpose({ maxFlightHours: 2 }), ["FRA"])).toMatchObject({ maxHours: 2 });
    expect(resolveSearchParams({}, purpose({}, ["Flug max 3 Stunden"]), ["FRA"])).toMatchObject({ maxHours: 3 });
    expect(resolveSearchParams({}, purpose(), ["FRA"])).toMatchObject({ maxHours: null });
    expect(resolveSearchParams({ maxFlightHours: null }, purpose({ maxFlightHours: 2 }), ["FRA"])).toMatchObject({ maxHours: null });
    expect(resolveSearchParams({ maxFlightHours: 4 }, purpose({ maxFlightHours: 2 }), ["FRA"])).toMatchObject({ maxHours: 4 });
  });
  it("a limit without airports is ignored (no radius)", () => {
    expect(resolveSearchParams({ origins: [], maxFlightHours: 3 }, purpose(), ["FRA"])).toMatchObject({ origins: [], maxHours: null });
    expect(resolveSearchParams({}, purpose({ maxFlightHours: 3 }), [])).toMatchObject({ origins: [], maxHours: null });
  });
  it("an unknown airport code is rejected", () => {
    expect(resolveSearchParams({ origins: ["ZZZ"] }, purpose(), ["FRA"])).toEqual({ ok: false, error: "unknown_airport" });
  });
});

describe("round 2: Show others (D13)", () => {
  const row = (o: Partial<StoredSearch> = {}) => stored({ cards: [card(1), card(2)], ...o });

  it("one more call on the same row: exclusions = all anchors of round 1, existing cards are not repeated, cards are appended", async () => {
    h.byId.mockResolvedValue(row());
    h.propose.mockResolvedValue({ ok: true, data: [idea("Faro")], usage: {} });
    h.finish.mockImplementation(async (_sb: unknown, _id: string, p: { cards: unknown[]; previous: StoredSearch }) => stored({ cards: [...p.previous.cards, ...(p.cards as never[])], rounds: 2 }));
    const r = await showOtherDestinations(SEARCH);
    expect(r).toMatchObject({ ok: true, data: { rounds: 2, canShowOthers: false } });
    expect(h.propose.mock.calls[0][0].exclude).toEqual(["Marbella", "Palma"]);
    expect(h.verify.mock.calls[0][0]).toMatchObject({ round: 2, existing: [{ geoId: 1 }, { geoId: 2 }], origins: ["FRA", "MUC"], maxHours: null });
    expect(h.finish.mock.calls[0][2]).toMatchObject({ round: 2 });
    expect(h.claim2).toHaveBeenCalledTimes(1);
  });

  it("falls back to the place names of the cards when the stored input has no exclusions", async () => {
    h.byId.mockResolvedValue(row({ input: { v: 1, lang: "de", purpose: { interests: [], custom: [], hard: [], soft: [] }, count: 8 }, cards: [{ ...card(1), placeName: "Marbella" }] }));
    await showOtherDestinations(SEARCH);
    expect(h.propose.mock.calls[0][0].exclude).toEqual(["Marbella"]);
  });

  it("never a third call: rounds already 2, a failed list or a missing list cannot ask again", async () => {
    h.byId.mockResolvedValue(row({ rounds: 2 }));
    expect(await showOtherDestinations(SEARCH)).toMatchObject({ ok: false, error: "conflict" });
    h.byId.mockResolvedValue(row({ status: "failed" }));
    expect(await showOtherDestinations(SEARCH)).toMatchObject({ ok: false, error: "conflict" });
    h.byId.mockResolvedValue(row({ status: "running" }));
    expect(await showOtherDestinations(SEARCH)).toMatchObject({ ok: false, error: "busy" });
    h.byId.mockResolvedValue(null);
    expect(await showOtherDestinations(SEARCH)).toMatchObject({ ok: false, error: "not_found" });
    expect(await showOtherDestinations("nope")).toMatchObject({ ok: false, error: "not_found" });
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("the same gates as a first run: AI off, rate, daily runs, budget, claim", async () => {
    h.byId.mockResolvedValue(row());
    h.env = { AI_ENABLED: "false" };
    expect(await showOtherDestinations(SEARCH)).toMatchObject({ ok: false, error: "ai_disabled" });
    h.env = { AI_ENABLED: "true", ANTHROPIC_API_KEY: "k" };
    h.runs = 10;
    expect(await showOtherDestinations(SEARCH)).toMatchObject({ ok: false, error: "search_limit" });
    h.runs = 0;
    resetRateLimits();
    h.budgetOk = false;
    expect(await showOtherDestinations(SEARCH)).toMatchObject({ ok: false, error: "budget_exceeded" });
    h.budgetOk = true;
    resetRateLimits();
    h.claim2.mockResolvedValue({ ok: false, reason: "busy" });
    expect(await showOtherDestinations(SEARCH)).toMatchObject({ ok: false, error: "busy" });
    h.claim2.mockResolvedValue({ ok: false, reason: "exists" });
    resetRateLimits();
    expect(await showOtherDestinations(SEARCH)).toMatchObject({ ok: false, error: "conflict" });
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("a failed second call goes back to the list (round 1 cards stay, round stays unused)", async () => {
    h.byId.mockResolvedValue(row());
    h.propose.mockResolvedValue({ ok: false, error: "ai_unavailable" });
    expect(await showOtherDestinations(SEARCH)).toMatchObject({ ok: false, error: "ai_unavailable" });
    expect(h.failRound).toHaveBeenCalledWith(expect.anything(), SEARCH, expect.objectContaining({ round: 2, previous: expect.objectContaining({ id: SEARCH }) }));
  });
});

describe("GET state", () => {
  it("returns the row for the owner; the internals stay on the server", async () => {
    const r = await getDestinationSearch(SEARCH);
    expect(r).toMatchObject({ ok: true, data: { id: SEARCH, status: "done", canShowOthers: true, aiEnabled: true } });
    if (r.ok) {
      const keys = Object.keys(r.data);
      for (const hidden of ["inputHash", "input", "busyUntil", "costMicroUsd"]) expect(keys).not.toContain(hidden);
    }
  });
  it("auth, id shape and RLS (a row of another owner reads as missing)", async () => {
    h.session = null;
    expect(await getDestinationSearch(SEARCH)).toMatchObject({ ok: false, error: "unauthenticated" });
    h.session = { userId: "u1", supabase: {} };
    expect(await getDestinationSearch("nope")).toMatchObject({ ok: false, error: "not_found" });
    h.byId.mockResolvedValue(null);
    expect(await getDestinationSearch(SEARCH)).toMatchObject({ ok: false, error: "not_found" });
  });
  it("canShowOthers is false with AI off, while running, after round 2 and for failed lists", async () => {
    h.env = {};
    expect(await getDestinationSearch(SEARCH)).toMatchObject({ data: { canShowOthers: false, aiEnabled: false } });
    h.env = { AI_ENABLED: "true", ANTHROPIC_API_KEY: "k" };
    h.byId.mockResolvedValue(stored({ status: "running" }));
    expect(await getDestinationSearch(SEARCH)).toMatchObject({ data: { canShowOthers: false } });
    h.byId.mockResolvedValue(stored({ rounds: 2 }));
    expect(await getDestinationSearch(SEARCH)).toMatchObject({ data: { canShowOthers: false } });
    h.byId.mockResolvedValue(stored({ status: "failed", error: "ai_unavailable" }));
    expect(await getDestinationSearch(SEARCH)).toMatchObject({ data: { canShowOthers: false, error: "ai_unavailable" } });
  });
});

describe("drive mode (find-destinations-drive)", () => {
  const FRANKFURT = { geoId: 2925533, name: "Frankfurt am Main", featureCode: "PPLA", countryCode: "DE", admin1: "Hesse", lat: 50.11, lon: 8.68, timezone: "Europe/Berlin", population: 750000, suggestedKind: "city" };
  const drive = { ...body, travelMode: "drive", maxDriveHours: 4 };
  const withHome = () => {
    h.profile = { ...h.profile, homeLocation: "Frankfurt am Main, Hesse, Germany", homeTimezone: "Europe/Berlin", homeGeoId: 2925533, homeLat: 50.11, homeLon: 8.68 };
  };

  beforeEach(() => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "k");
    h.orsLeft = 400;
    h.placeById.mockReset();
    h.profileUpdate.mockClear();
    h.session = { userId: "u1", supabase: { from: () => ({ update: () => ({ eq: async () => h.profileUpdate() }) }) } };
    h.claim1.mockImplementation(async (_sb: unknown, n: Record<string, unknown>) => ({
      ok: true,
      search: stored({
        status: "running",
        travelMode: n.travelMode as "flight" | "drive",
        maxDriveHours: n.maxDriveHours as number | null,
        origins: n.origins as string[],
        homeName: (n.home as { name: string } | null)?.name ?? null,
        homeLat: (n.home as { lat: number } | null)?.lat ?? null,
        homeLon: (n.home as { lon: number } | null)?.lon ?? null,
      }),
    }));
    h.verify.mockResolvedValue({ cards: [card(1)], drops: {}, reasonsRemoved: 0, geocodeDown: false, driveDown: false, stoppedBy: null, climateMisses: 0, driveLookups: 6 });
    withHome();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("the model gets the home name, a drive travel and a 90 km/h radius hint; coordinates and cell stay out", async () => {
    const r = await runDestinationSearch(drive);
    expect(r).toMatchObject({ ok: true });
    const sent = h.propose.mock.calls[0][0];
    expect(sent).toMatchObject({ from: ["Frankfurt am Main, Hesse, Germany"], travel: "drive", radiusKm: 360, homeCell: "50.11,8.68" });
    expect(sent.fromIata).toBeUndefined();
    const claim = h.claim1.mock.calls[0][1];
    expect(claim).toMatchObject({
      travelMode: "drive", maxDriveHours: 4, origins: [], maxFlightHours: null, radiusKm: 360,
      home: { name: "Frankfurt am Main, Hesse, Germany", lat: 50.11, lon: 8.68 },
    });
    expect(h.verify.mock.calls[0][0]).toMatchObject({ origins: [], maxHours: null, drive: { home: { lat: 50.11, lon: 8.68 }, maxHours: 4 } });
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "destination.searched", props: expect.objectContaining({ travelMode: "drive", driveLookups: 6 }) }));
    expect(JSON.stringify(h.logEvent.mock.calls)).not.toMatch(/Frankfurt/);
  });

  it("the view never carries coordinates", async () => {
    const r = await runDestinationSearch(drive);
    expect(JSON.stringify(r)).not.toMatch(/homeLat|homeLon|50\.11/);
  });

  it("a flight limit in the purpose is ignored in drive mode, profile airports are not used", async () => {
    h.purpose = { ...h.purpose, constraints: ["max 3 h flight from FRA"] };
    await runDestinationSearch(drive);
    expect(h.claim1.mock.calls[0][1]).toMatchObject({ origins: [], maxFlightHours: null });
    expect(h.verify.mock.calls[0][0]).toMatchObject({ origins: [], maxHours: null });
    expect(h.propose.mock.calls[0][0].purpose.hard).toEqual([]);
  });

  it("the form's mixes are refused: drive without a limit, with airports or a flight limit; flight with a drive limit", async () => {
    for (const bad of [
      { ...body, travelMode: "drive" },
      { ...drive, origins: [] },
      { ...drive, maxFlightHours: null },
      { ...body, maxDriveHours: 4 },
      { ...body, homeGeoId: 1 },
      { ...body, saveHome: true },
      { ...drive, maxDriveHours: 13 },
      { ...drive, maxDriveHours: 4.2 },
    ]) {
      expect(await runDestinationSearch(bad)).toMatchObject({ ok: false, error: "invalid" });
    }
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("no start: no home, or a home saved before coordinates existed -> home_required, no AI call", async () => {
    h.profile = { ...h.profile, homeLocation: null, homeTimezone: null, homeGeoId: null, homeLat: null, homeLon: null };
    expect(await runDestinationSearch(drive)).toMatchObject({ ok: false, error: "home_required" });
    h.profile = { ...h.profile, homeLocation: "Berlin", homeTimezone: "Europe/Berlin" }; // legacy: name without coordinates
    expect(await runDestinationSearch(drive)).toMatchObject({ ok: false, error: "home_required" });
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("a start picked in the form is resolved by the server from its id; the profile home is not touched", async () => {
    h.placeById.mockResolvedValue({ ...FRANKFURT, geoId: 2867714, name: "München", lat: 48.14, lon: 11.58 });
    await runDestinationSearch({ ...drive, homeGeoId: 2867714 });
    expect(h.placeById).toHaveBeenCalledWith(2867714, "de");
    expect(h.claim1.mock.calls[0][1].home).toMatchObject({ lat: 48.14, lon: 11.58 });
    expect(h.propose.mock.calls[0][0].homeCell).toBe("48.14,11.58");
    expect(h.profileUpdate).not.toHaveBeenCalled();
  });

  it("'Save as my home' writes the profile home, only with a time zone", async () => {
    h.placeById.mockResolvedValue(FRANKFURT);
    await runDestinationSearch({ ...drive, homeGeoId: 2925533, saveHome: true });
    expect(h.profileUpdate).toHaveBeenCalledTimes(1);
  });

  it("a failed or empty place lookup is places_unavailable", async () => {
    h.placeById.mockRejectedValue(new Error("down"));
    expect(await runDestinationSearch({ ...drive, homeGeoId: 5 })).toMatchObject({ ok: false, error: "places_unavailable" });
    h.placeById.mockResolvedValue(null);
    expect(await runDestinationSearch({ ...drive, homeGeoId: 5 })).toMatchObject({ ok: false, error: "places_unavailable" });
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("two towns of the same name differ by the hash (homeCell)", async () => {
    h.placeById.mockResolvedValueOnce({ ...FRANKFURT, name: "Neustadt", lat: 49.35, lon: 8.14 }).mockResolvedValueOnce({ ...FRANKFURT, name: "Neustadt", lat: 54.1, lon: 10.8 });
    await runDestinationSearch({ ...drive, homeGeoId: 1 });
    resetRateLimits();
    await runDestinationSearch({ ...drive, homeGeoId: 2 });
    expect(h.claim1.mock.calls[0][1].inputHash).not.toBe(h.claim1.mock.calls[1][1].inputHash);
  });

  it("ORS gate before the LLM call: key missing, or fewer than 8 + 50 requests left -> drive_unavailable, no Haiku call (tags included)", async () => {
    h.wantsTags = true;
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "");
    expect(await runDestinationSearch(drive)).toMatchObject({ ok: false, error: "drive_unavailable" });
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "k");
    h.orsLeft = 57;
    expect(await runDestinationSearch(drive)).toMatchObject({ ok: false, error: "drive_unavailable" });
    expect(h.propose).not.toHaveBeenCalled();
    expect(h.tagAndSave).not.toHaveBeenCalled();
    expect(h.claim1).not.toHaveBeenCalled();
    h.wantsTags = false;
    h.orsLeft = 58;
    expect(await runDestinationSearch(drive)).toMatchObject({ ok: true });
  });

  it("a saved list for the same input is served with ORS down and the key gone", async () => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "");
    h.orsLeft = 0;
    h.byHash.mockResolvedValue(stored({ travelMode: "drive", cards: [card(1)] }));
    expect(await runDestinationSearch(drive)).toMatchObject({ ok: true, data: { cached: true } });
    expect(h.propose).not.toHaveBeenCalled();
  });

  it("flight searches do not need ORS", async () => {
    vi.stubEnv("OPENROUTESERVICE_API_KEY", "");
    h.orsLeft = 0;
    expect(await runDestinationSearch(body)).toMatchObject({ ok: true });
  });

  it("ORS failed on the first places: the row is failed with drive_unavailable, no card is saved", async () => {
    h.verify.mockResolvedValue({ cards: [], drops: { drive_failed: 2 }, reasonsRemoved: 0, geocodeDown: false, driveDown: true, stoppedBy: null, climateMisses: 0, driveLookups: 2 });
    expect(await runDestinationSearch(drive)).toMatchObject({ ok: false, error: "drive_unavailable" });
    expect(h.failRound).toHaveBeenCalledWith(expect.anything(), SEARCH, expect.objectContaining({ error: "drive_unavailable" }));
    expect(h.finish).not.toHaveBeenCalled();
  });

  it("round 2 uses the start saved on the row after the profile home changed, and has the same ORS gate", async () => {
    h.profile = { ...h.profile, homeLocation: "Berlin", homeTimezone: "Europe/Berlin", homeGeoId: 2950159, homeLat: 52.52, homeLon: 13.4 };
    const row = stored({ travelMode: "drive", maxDriveHours: 3, homeName: "Frankfurt", homeLat: 50.11, homeLon: 8.68, origins: [], cards: [card(1)] });
    h.byId.mockResolvedValue(row);
    h.claim2.mockResolvedValue({ ok: true, search: { ...row, status: "running" } });
    h.orsLeft = 10;
    expect(await showOtherDestinations(SEARCH)).toMatchObject({ ok: false, error: "drive_unavailable" });
    expect(h.propose).not.toHaveBeenCalled();
    expect(h.claim2).not.toHaveBeenCalled();
    h.orsLeft = 400;
    await showOtherDestinations(SEARCH);
    expect(h.verify.mock.calls[0][0]).toMatchObject({ round: 2, drive: { home: { lat: 50.11, lon: 8.68 }, maxHours: 3 } });
  });

  it("round 2 of an old flight list runs as flight", async () => {
    h.byId.mockResolvedValue(stored({ cards: [card(1)] }));
    await showOtherDestinations(SEARCH);
    expect(h.verify.mock.calls[0][0].drive).toBeUndefined();
  });
});

describe("resolveSearchParams in drive mode", () => {
  it("origins [] and no flight limit, whatever the profile or the purpose says", () => {
    const purpose = { guided: { maxFlightHours: 2 }, constraints: [] } as never;
    expect(resolveSearchParams({ travelMode: "drive" }, purpose, ["FRA", "MUC"])).toEqual({ ok: true, origins: [], maxHours: null });
  });
});
