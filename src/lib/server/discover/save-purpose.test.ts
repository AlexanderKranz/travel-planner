import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
type Ops = [string, unknown[]][];
const h = vi.hoisted(() => ({
  session: true as boolean,
  db: vi.fn<(table: string, ops: [string, unknown[]][]) => unknown>(),
  byId: vi.fn(),
  searchTags: vi.fn(),
  insert: vi.fn(),
  saveTags: vi.fn(),
  logEvent: vi.fn(async () => {}),
}));

vi.mock("../session", () => ({
  getUserSession: async () =>
    h.session
      ? {
          userId: "u1",
          supabase: {
            from(table: string) {
              const ops: Ops = [];
              const q: Record<string, unknown> = {};
              for (const m of ["select", "update", "delete", "eq", "is", "order", "limit", "returns"]) q[m] = (...a: unknown[]) => (ops.push([m, a]), q);
              q.maybeSingle = (...a: unknown[]) => (ops.push(["maybeSingle", a]), Promise.resolve(h.db(table, ops)));
              q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(h.db(table, ops)).then(res, rej);
              return q;
            },
          },
        }
      : null,
}));
vi.mock("../events", () => ({ logEvent: h.logEvent }));
vi.mock("../plan-store", () => ({ savePurposeTags: h.saveTags }));
vi.mock("../purpose-insert", () => ({ insertPurposeRow: h.insert }));
vi.mock("./store", () => ({ getSearchById: h.byId, getSearchTags: h.searchTags }));

import { oneOffTagsHash } from "@/lib/discover/one-off";
import { resetRateLimits } from "../rate-limit";
import type { StoredSearch } from "./store";
import { saveSearchAsPurpose } from "./save-purpose";

const SEARCH = "33333333-3333-4333-8333-333333333333";
const NEW_ID = "44444444-4444-4444-8444-444444444444";
const OLD_ID = "55555555-5555-4555-8555-555555555555";
const TEXT = "Golf mit einem Freund";
const TAGS = { v: 1, interests: ["golf"], custom: [], hard: [], soft: [], summary: "Golf" };

const row = (o: Partial<StoredSearch> = {}) => ({ id: SEARCH, purposeId: null, purposeName: "Golf mit einem Freund", purposeText: TEXT, status: "done", ...o }) as StoredSearch;
const opsHave = (ops: Ops, m: string, args: unknown[]) => ops.some(([n, a]) => n === m && JSON.stringify(a) === JSON.stringify(args));

/** Programmable database: per table and operation. */
const world = {
  identical: [] as unknown[],
  names: {} as Record<string, string>,
  linked: true,
  deleted: [] as string[],
  linkOps: [] as Ops,
};

beforeEach(() => {
  resetRateLimits();
  vi.clearAllMocks();
  h.session = true;
  world.identical = [];
  world.names = { [OLD_ID]: "Old name" };
  world.linked = true;
  world.deleted = [];
  world.linkOps = [];
  h.byId.mockResolvedValue(row());
  h.searchTags.mockResolvedValue({ tags: TAGS, hash: oneOffTagsHash(TEXT) });
  h.insert.mockResolvedValue({ data: { id: NEW_ID, name: "Golf trips" }, error: null });
  h.saveTags.mockResolvedValue({ updatedAt: "t" });
  h.db.mockImplementation((table, ops) => {
    const has = (m: string) => ops.some(([n]) => n === m);
    if (table === "trip_purposes" && has("delete")) {
      world.deleted.push(String(ops.find(([n]) => n === "eq")![1][1]));
      return { error: null };
    }
    if (table === "trip_purposes" && has("maybeSingle")) {
      const id = String(ops.find(([n]) => n === "eq")![1][1]);
      return { data: world.names[id] ? { name: world.names[id] } : null, error: null };
    }
    if (table === "trip_purposes") return { data: world.identical, error: null };
    if (table === "destination_searches" && has("update")) {
      world.linkOps = ops;
      return { data: world.linked ? [{ id: SEARCH }] : [], error: null };
    }
    throw new Error(`unexpected ${table}`);
  });
});

describe("request checks", () => {
  it("no session, bad id and bad name are refused before any read", async () => {
    h.session = false;
    expect(await saveSearchAsPurpose(SEARCH, { name: "x" })).toMatchObject({ ok: false, error: "unauthenticated" });
    h.session = true;
    expect(await saveSearchAsPurpose("nope", { name: "x" })).toMatchObject({ ok: false, error: "not_found" });
    expect(await saveSearchAsPurpose(SEARCH, {})).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveSearchAsPurpose(SEARCH, { name: "  " })).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveSearchAsPurpose(SEARCH, { name: "x".repeat(81) })).toMatchObject({ ok: false, error: "invalid" });
    expect(h.byId).not.toHaveBeenCalled();
  });
  it("rate limited like other writes", async () => {
    h.byId.mockResolvedValue(null);
    for (let i = 0; i < 30; i++) expect(await saveSearchAsPurpose(SEARCH, { name: "x" })).toMatchObject({ error: "not_found" });
    expect(await saveSearchAsPurpose(SEARCH, { name: "x" })).toMatchObject({ ok: false, error: "rate_limited" });
  });
  it("missing list -> not_found; a saved-purpose request took the row over -> conflict; running -> busy", async () => {
    h.byId.mockResolvedValueOnce(null);
    expect(await saveSearchAsPurpose(SEARCH, { name: "Golf" })).toMatchObject({ ok: false, error: "not_found" });
    h.byId.mockResolvedValueOnce(row({ purposeText: null, purposeId: OLD_ID }));
    expect(await saveSearchAsPurpose(SEARCH, { name: "Golf" })).toMatchObject({ ok: false, error: "conflict" });
    h.byId.mockResolvedValueOnce(row({ status: "running" }));
    expect(await saveSearchAsPurpose(SEARCH, { name: "Golf" })).toMatchObject({ ok: false, error: "busy" });
    expect(h.insert).not.toHaveBeenCalled();
  });
});

describe("save as purpose (13.4)", () => {
  it("already linked: returns the purpose, created false, writes nothing (second click, second tab)", async () => {
    h.byId.mockResolvedValue(row({ purposeId: OLD_ID }));
    expect(await saveSearchAsPurpose(SEARCH, { name: "Golf" })).toEqual({ ok: true, data: { purposeId: OLD_ID, name: "Old name", created: false } });
    expect(h.insert).not.toHaveBeenCalled();
    expect(world.linkOps).toEqual([]);
    expect(h.logEvent).not.toHaveBeenCalled();
  });
  it("an identical purpose (same text, no constraints, no guided) is linked, no duplicate", async () => {
    world.identical = [
      { id: "66666666-6666-4666-8666-666666666666", name: "With rules", guided: {}, constraints: ["single rooms"] },
      { id: OLD_ID, name: "Old name", guided: {}, constraints: [] },
    ];
    const res = await saveSearchAsPurpose(SEARCH, { name: "Another name" });
    expect(res).toEqual({ ok: true, data: { purposeId: OLD_ID, name: "Old name", created: false } });
    expect(h.insert).not.toHaveBeenCalled();
    expect(opsHave(world.linkOps, "update", [{ purpose_id: OLD_ID, purpose_name: "Old name" }])).toBe(true);
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "destination.purpose_saved", props: { created: false, linkedExisting: true, tagged: false } }));
  });
  it("a purpose with guided fields is not identical", async () => {
    world.identical = [{ id: OLD_ID, name: "Old name", guided: { interests: ["golf"] }, constraints: [] }];
    const res = await saveSearchAsPurpose(SEARCH, { name: "Golf trips" });
    expect(res).toMatchObject({ ok: true, data: { purposeId: NEW_ID, created: true } });
  });
  it("new purpose: text copied, tags copied without any LLM call, search linked conditionally on the text read", async () => {
    const res = await saveSearchAsPurpose(SEARCH, { name: "  Golf trips " });
    expect(res).toEqual({ ok: true, data: { purposeId: NEW_ID, name: "Golf trips", created: true } });
    expect(h.insert).toHaveBeenCalledWith(expect.anything(), { name: "Golf trips", text: TEXT, guided: {}, constraints: [] });
    expect(h.saveTags).toHaveBeenCalledWith("u1", NEW_ID, TAGS, oneOffTagsHash(TEXT));
    expect(opsHave(world.linkOps, "update", [{ purpose_id: NEW_ID, purpose_name: "Golf trips" }])).toBe(true);
    expect(opsHave(world.linkOps, "is", ["purpose_id", null])).toBe(true);
    expect(opsHave(world.linkOps, "eq", ["purpose_text", TEXT])).toBe(true);
    expect(opsHave(world.linkOps, "eq", ["id", SEARCH])).toBe(true);
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "destination.purpose_saved", props: { created: true, linkedExisting: false, tagged: true } }));
    expect(world.deleted).toEqual([]);
  });
  it("tags made for another text (or none) are not copied: the purpose is saved untagged", async () => {
    h.searchTags.mockResolvedValue({ tags: TAGS, hash: oneOffTagsHash("something else entirely") });
    expect(await saveSearchAsPurpose(SEARCH, { name: "Golf trips" })).toMatchObject({ ok: true, data: { created: true } });
    expect(h.saveTags).not.toHaveBeenCalled();
    h.searchTags.mockResolvedValue(null);
    await saveSearchAsPurpose(SEARCH, { name: "Golf trips" });
    expect(h.saveTags).not.toHaveBeenCalled();
    expect(h.logEvent).toHaveBeenLastCalledWith(expect.objectContaining({ props: { created: true, linkedExisting: false, tagged: false } }));
  });
  it("lost race, the search was linked meanwhile: our insert is deleted and the winner's purpose returned", async () => {
    world.linked = false;
    h.byId.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ purposeId: OLD_ID }));
    const res = await saveSearchAsPurpose(SEARCH, { name: "Golf trips" });
    expect(res).toEqual({ ok: true, data: { purposeId: OLD_ID, name: "Old name", created: false } });
    expect(world.deleted).toEqual([NEW_ID]);
    expect(h.logEvent).not.toHaveBeenCalled();
  });
  it("a relabel between read and link gives conflict, and our insert is deleted", async () => {
    world.linked = false;
    h.byId.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ purposeId: null, purposeText: "another text" }));
    expect(await saveSearchAsPurpose(SEARCH, { name: "Golf trips" })).toMatchObject({ ok: false, error: "conflict" });
    expect(world.deleted).toEqual([NEW_ID]);
  });
  it("a lost race with an identical existing purpose deletes nothing", async () => {
    world.identical = [{ id: OLD_ID, name: "Old name", guided: {}, constraints: [] }];
    world.linked = false;
    h.byId.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ purposeId: OLD_ID }));
    await saveSearchAsPurpose(SEARCH, { name: "x" });
    expect(world.deleted).toEqual([]);
  });
  it("insert failure -> failed, nothing linked", async () => {
    h.insert.mockResolvedValue({ data: null, error: { code: "x" } });
    expect(await saveSearchAsPurpose(SEARCH, { name: "Golf trips" })).toMatchObject({ ok: false, error: "failed" });
    expect(world.linkOps).toEqual([]);
  });
  it("an exception after the insert removes the insert and reports failed", async () => {
    h.saveTags.mockRejectedValue(new Error("boom"));
    expect(await saveSearchAsPurpose(SEARCH, { name: "Golf trips" })).toMatchObject({ ok: false, error: "failed" });
    expect(world.deleted).toEqual([NEW_ID]);
  });
  it("never logs the text, the label or the name", async () => {
    await saveSearchAsPurpose(SEARCH, { name: "Golf trips" });
    const all = JSON.stringify(h.logEvent.mock.calls);
    expect(all).not.toContain("Golf mit");
    expect(all).not.toContain("Golf trips");
  });
});
