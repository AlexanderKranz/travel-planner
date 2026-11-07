import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Result = { data?: unknown; error?: { code?: string; message?: string } | null };

const VIEWER = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "bbbbbbbb-0000-4000-8000-000000000002";
const OTHER = "cccccccc-0000-4000-8000-000000000003";
const GROUP = "11111111-1111-4111-8111-111111111111";
const E_SELF = "20000000-0000-4000-8000-000000000001";
const E_PLAIN = "20000000-0000-4000-8000-000000000002";
const E_LINKED_OTHER = "20000000-0000-4000-8000-000000000003";
const E_LINKED_ME = "20000000-0000-4000-8000-000000000004";

const h = vi.hoisted(() => ({
  userId: "" as string,
  results: {} as Record<string, Result>,
  rpc: vi.fn(),
  rpcFor: {} as Record<string, Result>,
  parse: vi.fn(async () => false),
  ownerCtx: vi.fn(),
  events: vi.fn(),
  calls: [] as { table: string; eqs: [string, unknown][] }[],
}));

function builder(table: string) {
  const call = { table, eqs: [] as [string, unknown][] };
  h.calls.push(call);
  const settle = (): Result => ({ data: null, error: null, ...(h.results[table] ?? {}) });
  const b: Record<string, unknown> = {};
  for (const m of ["select", "order"]) b[m] = () => b;
  b.eq = (c: string, v: unknown) => (call.eqs.push([c, v]), b);
  b.maybeSingle = async () => settle();
  b.then = (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(settle()).then(res, rej);
  return b;
}

vi.mock("./session", () => ({
  getUserSession: async () => ({
    userId: h.userId,
    supabase: {
      from: builder,
      rpc: async (name: string, args: unknown) => {
        h.rpc(name, args);
        return h.rpcFor[name] ?? { data: null, error: null };
      },
    },
  }),
  todayIso: () => "2026-11-07",
}));
vi.mock("./events", () => ({ logEvent: h.events }));
vi.mock("./group-text", () => ({ ensureGroupParse: h.parse }));
vi.mock("./owner-context", () => ({ loadGroupOwnerBirthdate: h.ownerCtx }));

import { getGroup, listGroups, reorderGroupEntries, updateGroup } from "./groups";

const groupRow = (over: Record<string, unknown> = {}) => ({
  id: GROUP, owner_id: OWNER, name: "Friends", notes: null, description: null, parsed_structure: null, parsed_hash: null,
  trait_keys: [], created_at: "c", updated_at: "2026-11-01T10:00:00.000Z", group_shares: [], ...over,
});
const entryRow = (over: Record<string, unknown>) => ({
  group_id: GROUP, kind: "member", position: 0, count: 1, label: null, name: null, is_self: false, birthdate: null,
  age_mode: null, age: null, age_as_of: null, notes: null, traits: {}, linked_user_id: null, ...over,
});
const ENTRY_ROWS = [
  entryRow({ id: E_SELF, position: 0, is_self: true }),
  entryRow({ id: E_PLAIN, position: 1, name: "Plain", birthdate: "1990-01-01" }),
  entryRow({ id: E_LINKED_OTHER, position: 2, name: "Linked", linked_user_id: OTHER }),
  entryRow({ id: E_LINKED_ME, position: 3, name: "Mine", linked_user_id: VIEWER }),
];

/** The payload the group form sends: the stored entries unchanged unless `entries` is given. */
const self = { id: E_SELF, kind: "member", isSelf: true };
const plain = { id: E_PLAIN, kind: "member", name: "Plain", birthdate: "1990-01-01" };
const linkedOther = { id: E_LINKED_OTHER, kind: "member", name: "Linked" };
const linkedMe = { id: E_LINKED_ME, kind: "member", name: "Mine" };
const payload = (entries: unknown[] = [self, plain, linkedOther, linkedMe]) => ({ name: "Friends", entries }) as never;

const replaceCalls = () => h.rpc.mock.calls.filter((c) => c[0] === "replace_group_entries");

/** The viewer as a grantee of OWNER's group at a level (or no share row at all). */
const asGrantee = (access?: "read" | "write") => {
  h.userId = VIEWER;
  h.results["travel_groups"] = { data: groupRow({ group_shares: access ? [{ grantee_id: VIEWER, access }] : [] }) };
};
const asOwner = () => {
  h.userId = OWNER;
  h.results["travel_groups"] = { data: groupRow({ group_shares: [{ grantee_id: VIEWER, access: "write" }] }) };
};

beforeEach(() => {
  h.userId = VIEWER;
  h.results = { group_entries: { data: ENTRY_ROWS } };
  h.rpc.mockReset();
  h.rpcFor = {};
  h.parse.mockReset().mockResolvedValue(false);
  h.ownerCtx.mockReset().mockResolvedValue({ birthdate: "1960-05-01", displayName: "Olga" });
  h.events.mockReset();
  h.calls = [];
});

describe("updateGroup: access (group-sharing spec 3.4)", () => {
  it("a read grantee gets forbidden before anything is written", async () => {
    asGrantee("read");
    expect(await updateGroup(GROUP, payload())).toEqual({ ok: false, error: "forbidden" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("a group seen only through a shared trip (no share row) is read: forbidden", async () => {
    asGrantee(undefined);
    expect(await updateGroup(GROUP, payload())).toEqual({ ok: false, error: "forbidden" });
  });

  it("an invisible group is not_found", async () => {
    h.results["travel_groups"] = { data: null };
    expect(await updateGroup(GROUP, payload())).toEqual({ ok: false, error: "not_found" });
  });

  it("a write grantee may edit the entries and the owner's is_self entry (label, notes) as long as the rules hold", async () => {
    asGrantee("write");
    const res = await updateGroup(GROUP, payload([{ ...self, label: "Boss" }, { ...plain, name: "Plain 2" }, linkedOther, linkedMe, { kind: "member", name: "New" }]));
    expect(res.ok).toBe(true);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc.mock.calls[0][0]).toBe("replace_group_entries");
  });

  it("a write grantee may delete an entry linked to themselves and a plain one", async () => {
    asGrantee("write");
    await updateGroup(GROUP, payload([self, linkedOther]));
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("updateGroup: pre-checks for a write grantee (the guard trigger enforces the same)", () => {
  beforeEach(() => asGrantee("write"));

  it.each([
    ["drops the is_self entry", () => [plain, linkedOther, linkedMe]],
    ["turns the is_self entry into a plain member", () => [{ id: E_SELF, kind: "member", name: "Boss" }, plain, linkedOther, linkedMe]],
    ["flips is_self onto another entry", () => [{ id: E_SELF, kind: "member", name: "x" }, { ...plain, isSelf: true, birthdate: undefined, name: undefined }, linkedOther]],
    ["deletes an entry linked to someone else", () => [self, plain, linkedMe]],
    ["makes an entry linked to someone else a composition", () => [self, plain, { id: E_LINKED_OTHER, kind: "composition", count: 2 }, linkedMe]],
  ])("%s -> forbidden, no rpc", async (_name, entries) => {
    expect(await updateGroup(GROUP, payload(entries()))).toEqual({ ok: false, error: "forbidden" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("an unknown or repeated entry id is invalid", async () => {
    expect(await updateGroup(GROUP, payload([self, { ...plain, id: "30000000-0000-4000-8000-000000000009" }]))).toMatchObject({ ok: false, error: "invalid" });
    expect(await updateGroup(GROUP, payload([self, plain, plain, linkedOther]))).toMatchObject({ ok: false, error: "invalid" });
  });

  it("the owner is not restricted by these checks (the database clears links of entries made ineligible)", async () => {
    asOwner();
    await updateGroup(GROUP, payload([plain]));
    expect(replaceCalls()).toHaveLength(1);
  });

  it("a write grantee cannot add an is_self entry to a group that has none", async () => {
    h.results["group_entries"] = { data: ENTRY_ROWS.filter((e) => !e.is_self) };
    expect(await updateGroup(GROUP, payload([plain, linkedOther, { kind: "member", isSelf: true }]))).toEqual({ ok: false, error: "forbidden" });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe("updateGroup: optimistic check (spec 3.5) and database errors", () => {
  it("expectedUpdatedAt goes to the rpc as p_expected_updated_at; without it the argument is absent (Save anyway)", async () => {
    asOwner();
    await updateGroup(GROUP, payload(), "2026-11-01T10:00:00.000Z");
    expect(replaceCalls()[0][1]).toMatchObject({ p_group_id: GROUP, p_expected_updated_at: "2026-11-01T10:00:00.000Z" });
    await updateGroup(GROUP, payload());
    expect(replaceCalls()[1][1]).not.toHaveProperty("p_expected_updated_at");
  });

  it.each([
    ["40001", "conflict"],
    ["42501", "forbidden"],
    ["P0002", "not_found"],
    ["22023", "invalid"],
    ["XX000", "failed"],
  ])("rpc error %s -> %s", async (code, error) => {
    asOwner();
    h.rpcFor["replace_group_entries"] = { error: { code } };
    expect(await updateGroup(GROUP, payload())).toEqual({ ok: false, error });
  });
});

describe("the group-text parse is stored on the owner's row, the AI call is the actor's", () => {
  it("a write grantee's save asks for the parse with ownerId = the group owner and the actor's session", async () => {
    asGrantee("write");
    h.results["travel_groups"] = { data: groupRow({ description: "5 Freunde", group_shares: [{ grantee_id: VIEWER, access: "write" }] }) };
    h.parse.mockResolvedValue(false);
    const res = await updateGroup(GROUP, payload());
    expect(res.ok).toBe(true);
    expect(h.parse).toHaveBeenCalledTimes(1);
    const [session, target, text] = h.parse.mock.calls[0] as unknown as [{ userId: string }, Record<string, string>, string];
    expect(session.userId).toBe(VIEWER); // charged to the actor
    expect(target).toEqual({ table: "travel_groups", id: GROUP, ownerId: OWNER }); // saved on the owner's row
    expect(text).toBe("5 Freunde");
  });
});

describe("getGroup: access, usable, owner and links per viewer", () => {
  it("the owner: access owner, usable, no owner block; the is_self entry is 'me', linked people carry their names", async () => {
    h.userId = OWNER;
    h.results["travel_groups"] = { data: groupRow({ group_shares: [{ grantee_id: VIEWER, access: "read" }] }) };
    h.rpcFor["share_contacts"] = { data: [{ user_id: OTHER, display_name: "Otto", email: "" }] };
    const res = await getGroup(GROUP);
    expect(res.ok && res.data).toMatchObject({ ownerId: OWNER, access: "owner", usable: true, owner: null, myEntryId: E_SELF });
    const entries = res.ok ? res.data.entries : [];
    expect(entries.map((e) => e.link)).toEqual([{ kind: "me" }, undefined, { kind: "person", name: "Otto" }, { kind: "account" }]);
    expect(h.ownerCtx).not.toHaveBeenCalled();
  });

  it("a write recipient: own entry is 'me', other links carry no name, the owner comes with the birthdate (is_self exists)", async () => {
    asGrantee("write");
    const res = await getGroup(GROUP);
    expect(res.ok && res.data).toMatchObject({
      access: "write",
      usable: true,
      myEntryId: E_LINKED_ME,
      owner: { id: OWNER, name: "Olga", birthdate: "1960-05-01" },
    });
    expect(res.ok && res.data.entries.map((e) => e.link)).toEqual([undefined, undefined, { kind: "account" }, { kind: "me" }]);
    expect(h.ownerCtx).toHaveBeenCalledWith(OWNER); // secret key, after the RLS read
    expect(h.rpc).not.toHaveBeenCalled(); // no share_contacts for a recipient: no names of linked people
  });

  it("a group without an is_self entry sends the owner's age but never the birthdate", async () => {
    asGrantee("read");
    h.results["group_entries"] = { data: ENTRY_ROWS.filter((e) => !e.is_self) };
    const res = await getGroup(GROUP);
    expect(res.ok && res.data.owner).toMatchObject({ birthdate: null, name: "Olga" });
    expect(res.ok && typeof res.data.owner?.ageToday).toBe("number");
    expect(JSON.stringify(res)).not.toContain("1960");
  });

  it("a group reached only through a shared trip: read and not usable", async () => {
    asGrantee(undefined);
    const res = await getGroup(GROUP);
    expect(res.ok && res.data).toMatchObject({ access: "read", usable: false });
  });

  it("an unreadable owner profile degrades the display (name and birthdate empty), it does not leak or fail", async () => {
    asGrantee("read");
    h.ownerCtx.mockResolvedValue(null);
    const res = await getGroup(GROUP);
    expect(res.ok && res.data.owner).toEqual({ id: OWNER, name: null, birthdate: null, ageToday: null });
  });

  it("invalid ids and invisible groups", async () => {
    expect(await getGroup("x")).toEqual({ ok: false, error: "invalid" });
    h.results["travel_groups"] = { data: null };
    expect(await getGroup(GROUP)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("reorderGroupEntries", () => {
  const ids = [E_PLAIN, E_SELF, E_LINKED_OTHER, E_LINKED_ME];

  it("a read grantee gets forbidden, no rpc", async () => {
    asGrantee("read");
    expect(await reorderGroupEntries(GROUP, ids)).toEqual({ ok: false, error: "forbidden" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("a write grantee and the owner reorder; an invisible group is not_found; wrong ids are invalid", async () => {
    asGrantee("write");
    expect(await reorderGroupEntries(GROUP, ids)).toEqual({ ok: true });
    asOwner();
    expect(await reorderGroupEntries(GROUP, ids)).toEqual({ ok: true });
    expect(await reorderGroupEntries(GROUP, [E_SELF])).toMatchObject({ ok: false, error: "invalid" });
    h.results["travel_groups"] = { data: null };
    expect(await reorderGroupEntries(GROUP, ids)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("listGroups", () => {
  it("lists only own groups with access owner and the number of grants", async () => {
    h.results["travel_groups"] = {
      data: [{ id: GROUP, name: "G", notes: null, description: null, updated_at: "u", group_entries: [{ count: 3 }], share_count: [{ count: 2 }] }],
    };
    const res = await listGroups();
    expect(res).toEqual({
      ok: true,
      data: [{ id: GROUP, name: "G", notes: undefined, description: undefined, entryCount: 3, updatedAt: "u", access: "owner", sharedBy: null, shareCount: 2 }],
    });
    expect(h.calls[0].eqs).toEqual([["owner_id", VIEWER]]);
  });
});
