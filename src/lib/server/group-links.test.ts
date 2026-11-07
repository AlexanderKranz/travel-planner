import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  session: true as boolean,
  rpc: vi.fn(),
  events: vi.fn(),
}));

vi.mock("./session", () => ({
  getUserSession: async () => (h.session ? { userId: "u1", supabase: { rpc: h.rpc } } : null),
}));
vi.mock("./events", () => ({ logEvent: h.events }));

import { claimGroupEntry, unclaimGroupEntry } from "./group-links";

const ENTRY = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const raise = (message: string, code = "P0001") => ({ data: null, error: { code, message } });

beforeEach(() => {
  h.session = true;
  h.rpc.mockReset();
  h.events.mockReset();
});

describe("claimGroupEntry", () => {
  it("needs a session and a valid entry id; nothing is called otherwise", async () => {
    h.session = false;
    expect(await claimGroupEntry({ entryId: ENTRY })).toEqual({ ok: false, error: "unauthenticated" });
    h.session = true;
    expect(await claimGroupEntry({ entryId: "nope" })).toMatchObject({ ok: false, error: "invalid" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("calls claim_group_entry with the user session and returns the group id; the event has ids only", async () => {
    h.rpc.mockResolvedValue({ data: GROUP, error: null });
    expect(await claimGroupEntry({ entryId: ENTRY })).toEqual({ ok: true, data: { groupId: GROUP } });
    expect(h.rpc).toHaveBeenCalledWith("claim_group_entry", { p_entry_id: ENTRY });
    expect(h.events).toHaveBeenCalledWith({ event: "sharing.entry_linked", userId: "u1", props: { groupId: GROUP } });
  });

  it.each([
    ["not_found", "not_found"],
    ["forbidden", "forbidden"],
    ["not_eligible", "invalid"],
    ["already_linked", "already_linked"],
    ["already_claimed", "already_claimed"],
  ])("maps %s to %s and logs nothing", async (message, error) => {
    h.rpc.mockResolvedValue(raise(message));
    expect(await claimGroupEntry({ entryId: ENTRY })).toEqual({ ok: false, error });
    expect(h.events).not.toHaveBeenCalled();
  });

  it("a unique violation (parallel claim) is already_claimed; anything else is failed", async () => {
    h.rpc.mockResolvedValue(raise("duplicate key", "23505"));
    expect(await claimGroupEntry({ entryId: ENTRY })).toEqual({ ok: false, error: "already_claimed" });
    h.rpc.mockResolvedValue(raise("boom", "XX000"));
    expect(await claimGroupEntry({ entryId: ENTRY })).toEqual({ ok: false, error: "failed" });
    h.rpc.mockResolvedValue(raise("something_else"));
    expect(await claimGroupEntry({ entryId: ENTRY })).toEqual({ ok: false, error: "failed" });
    h.rpc.mockResolvedValue({ data: null, error: null });
    expect(await claimGroupEntry({ entryId: ENTRY })).toEqual({ ok: false, error: "failed" });
  });
});

describe("unclaimGroupEntry", () => {
  it("reads the first row of the returned table: the linked user is by self, the owner by owner", async () => {
    h.rpc.mockResolvedValue({ data: [{ group_id: GROUP, by_owner: false }], error: null });
    expect(await unclaimGroupEntry({ entryId: ENTRY })).toEqual({ ok: true, data: { groupId: GROUP } });
    expect(h.rpc).toHaveBeenCalledWith("unclaim_group_entry", { p_entry_id: ENTRY });
    expect(h.events).toHaveBeenLastCalledWith({ event: "sharing.entry_unlinked", userId: "u1", props: { groupId: GROUP, by: "self" } });
    h.rpc.mockResolvedValue({ data: [{ group_id: GROUP, by_owner: true }], error: null });
    await unclaimGroupEntry({ entryId: ENTRY });
    expect(h.events).toHaveBeenLastCalledWith({ event: "sharing.entry_unlinked", userId: "u1", props: { groupId: GROUP, by: "owner" } });
  });

  it("an empty table or no data is failed; errors are mapped", async () => {
    h.rpc.mockResolvedValue({ data: [], error: null });
    expect(await unclaimGroupEntry({ entryId: ENTRY })).toEqual({ ok: false, error: "failed" });
    h.rpc.mockResolvedValue(raise("forbidden"));
    expect(await unclaimGroupEntry({ entryId: ENTRY })).toEqual({ ok: false, error: "forbidden" });
    h.rpc.mockResolvedValue(raise("not_found"));
    expect(await unclaimGroupEntry({ entryId: ENTRY })).toEqual({ ok: false, error: "not_found" });
    expect(h.events).not.toHaveBeenCalled();
  });

  it("needs a session and a valid entry id", async () => {
    h.session = false;
    expect(await unclaimGroupEntry({ entryId: ENTRY })).toEqual({ ok: false, error: "unauthenticated" });
    h.session = true;
    expect(await unclaimGroupEntry({ entryId: "x" })).toMatchObject({ ok: false, error: "invalid" });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("events carry no names, notes or emails", () => {
  it("only string ids and the by flag", async () => {
    h.rpc.mockResolvedValueOnce({ data: GROUP, error: null }).mockResolvedValueOnce({ data: [{ group_id: GROUP, by_owner: true }], error: null });
    await claimGroupEntry({ entryId: ENTRY });
    await unclaimGroupEntry({ entryId: ENTRY });
    for (const [e] of h.events.mock.calls) {
      expect(e.event).toMatch(/^sharing\.entry_/);
      expect(Object.keys(e.props).sort()).toEqual(expect.arrayContaining(["groupId"]));
      expect(JSON.stringify(e)).not.toContain(ENTRY);
    }
  });
});
