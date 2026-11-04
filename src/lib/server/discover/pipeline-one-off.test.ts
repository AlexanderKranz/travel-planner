import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const TAGS = { v: 1, interests: ["golf"], custom: [], hard: ["flat courses"], soft: [], summary: "Golf trip with a friend" };
const h = vi.hoisted(() => ({
  profile: { role: "user", isDemo: false, locale: "de", birthdate: null, homeAirports: ["FRA", "MUC"] } as Record<string, unknown>,
  env: { AI_ENABLED: "true", ANTHROPIC_API_KEY: "k" } as Record<string, string>,
  getPurpose: vi.fn(),
  findTags: vi.fn(),
  tagPurpose: vi.fn(),
  tagAndSave: vi.fn(),
  adopt: vi.fn(),
  saveTags: vi.fn(async () => true),
  byHash: vi.fn(),
  claim1: vi.fn(),
  finish: vi.fn(),
  failRound: vi.fn(async () => {}),
  prune: vi.fn(async () => {}),
  propose: vi.fn(),
  verify: vi.fn(),
  logEvent: vi.fn(async () => {}),
  runs: 0,
}));

vi.mock("../session", () => ({ getUserSession: async () => ({ userId: "u1", supabase: {} }) }));
vi.mock("../profile", () => ({ getProfile: async () => ({ ok: true, data: h.profile }) }));
vi.mock("../purposes", () => ({ getPurpose: h.getPurpose }));
vi.mock("../groups", () => ({ getGroup: async () => ({ ok: false, error: "not_found" }) }));
vi.mock("../settings", () => ({ getEffectiveEnv: async () => h.env }));
vi.mock("../events", () => ({ logEvent: h.logEvent }));
vi.mock("../facts/ors-quota", () => ({ orsRequestsLeft: async () => 400 }));
vi.mock("@/lib/integrations/open-meteo-geocoding", () => ({ getPlaceById: vi.fn() }));
vi.mock("../purpose-tagging", () => ({ wantsTags: (p: { tags: unknown } | null) => !!p && p.tags == null, tagAndSave: h.tagAndSave }));
vi.mock("../ai/purpose-tags", () => ({ tagPurpose: h.tagPurpose }));
vi.mock("../ai/destination-ideas", () => ({ proposeIdeas: h.propose }));
vi.mock("./verify", () => ({ verifyIdeas: h.verify }));
vi.mock("../ai-usage", async (orig) => {
  const m = await orig<typeof import("../ai-usage")>();
  return {
    ...m,
    logAiUsage: vi.fn(async () => {}),
    getBudgetStatus: async () => ({ spentMicroUsd: 0, capMicroUsd: 500_000, resetsAt: "reset", globalSpentMicroUsd: 0, globalCapMicroUsd: 5_000_000 }),
  };
});
vi.mock("./store", async (orig) => {
  const m = await orig<typeof import("./store")>();
  return {
    ...m,
    findTagsByHash: h.findTags,
    adoptSource: h.adopt,
    saveSearchTags: h.saveTags,
    getSearchByHash: h.byHash,
    claimRound1: h.claim1,
    finishRound: h.finish,
    failRound: h.failRound,
    pruneSearches: h.prune,
    countRunsToday: async () => h.runs,
  };
});

import { oneOffLabel, oneOffTagsHash } from "@/lib/discover/one-off";
import { resetRateLimits } from "../rate-limit";
import type { StoredSearch } from "./store";
import { runDestinationSearch } from "./pipeline";

const PURPOSE = "11111111-1111-4111-8111-111111111111";
const SEARCH = "33333333-3333-4333-8333-333333333333";
const TEXT = "Golf mit einem Freund, max. 3 h Flug";

const stored = (o: Partial<StoredSearch> = {}): StoredSearch => ({
  id: SEARCH, purposeId: null, groupId: null, purposeName: oneOffLabel(TEXT), purposeText: TEXT, locale: "de", months: [], origins: ["FRA", "MUC"],
  travelMode: "flight", maxFlightHours: 3, maxDriveHours: null, homeName: null, radiusKm: 1000, status: "done", rounds: 1, cards: [], drops: {},
  error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), inputHash: "a".repeat(64),
  input: { v: 1, lang: "de", purpose: { interests: ["golf"], custom: [], hard: [], soft: [] }, count: 8, exclude: [] }, busyUntil: null,
  costMicroUsd: 0, homeLat: null, homeLon: null, ...o,
});
const eventProps = (name: string) =>
  (h.logEvent.mock.calls as unknown as [{ event: string; props: Record<string, unknown> }][]).filter((c) => c[0].event === name).map((c) => c[0].props);

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
  h.profile = { role: "user", isDemo: false, locale: "de", birthdate: null, homeAirports: ["FRA", "MUC"] };
  h.env = { AI_ENABLED: "true", ANTHROPIC_API_KEY: "k" };
  h.runs = 0;
  h.getPurpose.mockResolvedValue({ ok: true, data: { id: PURPOSE, name: "Golf", guided: { interests: ["golf"] }, constraints: [], tags: null, updatedAt: "t" } });
  h.findTags.mockResolvedValue(null);
  h.byHash.mockResolvedValue(null);
  h.adopt.mockImplementation(async (_sb: unknown, _u: string, row: StoredSearch) => ({ search: row, relabelled: false }));
  h.claim1.mockImplementation(async () => ({ ok: true, search: stored({ status: "running" }) }));
  h.finish.mockImplementation(async (_sb: unknown, _id: string, p: { cards: unknown[] }) => stored({ cards: p.cards as never }));
  h.propose.mockResolvedValue({ ok: true, data: [{ name: "Marbella", anchor: "Marbella", cc: "ES", reason: "r" }], usage: {} });
  h.verify.mockResolvedValue({ cards: [], drops: {}, reasonsRemoved: 0, geocodeDown: false, driveDown: false, stoppedBy: null, climateMisses: 0, driveLookups: 0, uncheckedAnchors: [] });
  h.tagPurpose.mockResolvedValue({ ok: true, data: TAGS, usage: {} });
});

describe("input", () => {
  it("both sources, or none, is invalid and reads nothing", async () => {
    expect(await runDestinationSearch({ purposeId: PURPOSE, purposeText: TEXT })).toMatchObject({ ok: false, error: "invalid" });
    expect(await runDestinationSearch({})).toMatchObject({ ok: false, error: "invalid" });
    expect(h.getPurpose).not.toHaveBeenCalled();
    expect(h.findTags).not.toHaveBeenCalled();
  });
  it("a typed text never reads a saved purpose", async () => {
    await runDestinationSearch({ purposeText: TEXT });
    expect(h.getPurpose).not.toHaveBeenCalled();
  });
});

describe("tag lookup order (13.2)", () => {
  it("found tags: looked up by the one-off hash before the saved-list lookup, no Haiku call, tags written to the claimed row", async () => {
    h.findTags.mockResolvedValue({ tags: TAGS, from: "search" });
    const res = await runDestinationSearch({ purposeText: `  ${TEXT}  ` });
    expect(res.ok).toBe(true);
    expect(h.findTags).toHaveBeenCalledWith(expect.anything(), oneOffTagsHash(TEXT));
    expect(h.findTags.mock.invocationCallOrder[0]).toBeLessThan(h.byHash.mock.invocationCallOrder[0]);
    expect(h.tagPurpose).not.toHaveBeenCalled();
    expect(h.tagAndSave).not.toHaveBeenCalled();
    expect(h.claim1).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purposeId: null, purposeText: TEXT, purposeName: oneOffLabel(TEXT) }),
      null,
    );
    expect(h.saveTags).toHaveBeenCalledWith("u1", SEARCH, TAGS, oneOffTagsHash(TEXT));
    expect(eventProps("destination.searched")[0]).toMatchObject({ source: "text", tagsFrom: "search", cached: false });
  });
  it("tags from a saved purpose with the same hash count as tagsFrom purpose", async () => {
    h.findTags.mockResolvedValue({ tags: TAGS, from: "purpose" });
    await runDestinationSearch({ purposeText: TEXT });
    expect(h.tagPurpose).not.toHaveBeenCalled();
    expect(eventProps("destination.searched")[0]).toMatchObject({ tagsFrom: "purpose" });
  });
  it("no tags anywhere: one Haiku call for a transient purpose, then the tags are written to the row", async () => {
    await runDestinationSearch({ purposeText: TEXT });
    expect(h.tagPurpose).toHaveBeenCalledTimes(1);
    expect(h.tagPurpose.mock.calls[0][0]).toMatchObject({ id: "", text: TEXT, constraints: [], guided: {}, tags: null });
    expect(h.tagAndSave).not.toHaveBeenCalled(); // never saved on a purpose
    expect(h.byHash).toHaveBeenCalledTimes(2); // before and after tagging
    expect(h.saveTags).toHaveBeenCalledWith("u1", SEARCH, TAGS, oneOffTagsHash(TEXT));
    expect(eventProps("destination.searched")[0]).toMatchObject({ source: "text", tagsFrom: "haiku" });
  });
  it("a tagging failure falls back to the text: event without purpose id or text, no tags written, the search still runs", async () => {
    h.tagPurpose.mockResolvedValue({ ok: false, error: "ai_unavailable" });
    const res = await runDestinationSearch({ purposeText: TEXT });
    expect(res.ok).toBe(true);
    expect(eventProps("purpose.tag_failed")).toEqual([{ source: "discover_text", reason: "ai_unavailable" }]);
    expect(h.saveTags).not.toHaveBeenCalled();
    expect(eventProps("destination.searched")[0]).toMatchObject({ tagsFrom: "none" });
  });
  it("the flight limit default comes from the typed text, as for a saved purpose", async () => {
    h.findTags.mockResolvedValue({ tags: TAGS, from: "search" });
    await runDestinationSearch({ purposeText: TEXT });
    expect(h.claim1.mock.calls[0][1]).toMatchObject({ maxFlightHours: 3, origins: ["FRA", "MUC"] });
  });
});

describe("served rows take the source of the request (13.3)", () => {
  it("gate 2 hit: adoptSource with the text and the tags, cached event with source and relabelled, no gates, works with AI off", async () => {
    h.env = {};
    h.runs = 99;
    h.findTags.mockResolvedValue({ tags: TAGS, from: "purpose" });
    const row = stored({ purposeId: PURPOSE, purposeText: null, purposeName: "Golf" });
    h.byHash.mockResolvedValue(row);
    h.adopt.mockResolvedValue({ search: stored(), relabelled: true });
    const res = await runDestinationSearch({ purposeText: TEXT });
    expect(h.adopt).toHaveBeenCalledWith(expect.anything(), "u1", row, { kind: "text", text: TEXT, tags: TAGS });
    expect(res).toMatchObject({ ok: true, data: { cached: true, purposeId: null, purposeText: TEXT } });
    expect(eventProps("destination.searched")).toEqual([{ cards: 0, rounds: 1, cached: true, source: "text", relabelled: true }]);
    expect(h.claim1).not.toHaveBeenCalled();
    expect(h.tagPurpose).not.toHaveBeenCalled();
  });
  it("saved request: adoptSource with the purpose, and no tag lookup for a text", async () => {
    const row = stored({ purposeId: null, purposeText: TEXT });
    h.byHash.mockResolvedValue(row);
    h.adopt.mockResolvedValue({ search: stored({ purposeId: PURPOSE, purposeText: null, purposeName: "Golf" }), relabelled: true });
    const res = await runDestinationSearch({ purposeId: PURPOSE });
    expect(h.adopt).toHaveBeenCalledWith(expect.anything(), "u1", row, { kind: "saved", purposeId: PURPOSE, name: "Golf" });
    expect(h.findTags).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: true, data: { purposeId: PURPOSE, purposeText: null } });
    expect(eventProps("destination.searched")[0]).toMatchObject({ source: "saved", relabelled: true });
  });
  it("the hit after tagging goes through adoptSource as well", async () => {
    const row = stored();
    h.byHash.mockResolvedValueOnce(null).mockResolvedValueOnce(row);
    await runDestinationSearch({ purposeText: TEXT });
    expect(h.tagPurpose).toHaveBeenCalledTimes(1);
    expect(h.adopt).toHaveBeenCalledWith(expect.anything(), "u1", row, { kind: "text", text: TEXT, tags: TAGS });
    expect(h.claim1).not.toHaveBeenCalled();
    expect(h.propose).not.toHaveBeenCalled();
  });
  it("the 'exists' result of the claim goes through adoptSource", async () => {
    h.findTags.mockResolvedValue({ tags: TAGS, from: "search" });
    const row = stored({ purposeId: PURPOSE, purposeText: null });
    h.claim1.mockResolvedValue({ ok: false, reason: "exists" });
    h.byHash.mockResolvedValueOnce(null).mockResolvedValueOnce(row);
    await runDestinationSearch({ purposeText: TEXT });
    expect(h.adopt).toHaveBeenCalledWith(expect.anything(), "u1", row, { kind: "text", text: TEXT, tags: TAGS });
    expect(h.propose).not.toHaveBeenCalled();
  });
  it("a failed or old row of the same hash is taken over in place with the text", async () => {
    h.findTags.mockResolvedValue({ tags: TAGS, from: "search" });
    h.byHash.mockResolvedValue(stored({ status: "failed", error: "failed" }));
    await runDestinationSearch({ purposeText: TEXT });
    expect(h.claim1).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ purposeId: null, purposeText: TEXT }), SEARCH);
  });
});

describe("saved purposes keep their path", () => {
  it("claim writes the purpose and no text; tagsFrom cached when the purpose had tags", async () => {
    h.getPurpose.mockResolvedValue({ ok: true, data: { id: PURPOSE, name: "Golf", guided: {}, constraints: [], tags: TAGS, updatedAt: "t" } });
    await runDestinationSearch({ purposeId: PURPOSE });
    expect(h.claim1.mock.calls[0][1]).toMatchObject({ purposeId: PURPOSE, purposeName: "Golf", purposeText: null });
    expect(h.saveTags).not.toHaveBeenCalled();
    expect(eventProps("destination.searched")[0]).toMatchObject({ source: "saved", tagsFrom: "cached" });
  });
});

describe("logging (13.6): never the text, the label or the name", () => {
  it("no event carries the typed text or its label", async () => {
    h.propose.mockResolvedValue({ ok: false, error: "ai_unavailable" });
    await runDestinationSearch({ purposeText: TEXT });
    h.tagPurpose.mockResolvedValue({ ok: false, error: "ai_unavailable" });
    await runDestinationSearch({ purposeText: `${TEXT} anders` });
    const all = JSON.stringify(h.logEvent.mock.calls);
    expect(all).not.toContain("Golf mit");
    expect(all).not.toContain(oneOffLabel(TEXT));
    expect(eventProps("destination.search_failed").every((p) => p.source === "text")).toBe(true);
  });
});
