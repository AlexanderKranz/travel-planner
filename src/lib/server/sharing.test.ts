import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Call = { table: string; op: string; eqs: [string, unknown][] };
type Result = { data?: unknown; error?: { code?: string; message?: string } | null };

const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "bbbbbbbb-0000-4000-8000-000000000002";
const GRANTEE = "cccccccc-0000-4000-8000-000000000003";
const TRIP = "11111111-1111-4111-8111-111111111111";
const SHARE = "22222222-2222-4222-8222-222222222222";
const EMAIL = "carol.secret@example.com";

const h = vi.hoisted(() => ({
  session: true as boolean,
  isAdmin: false,
  profile: { ok: true, data: { isDemo: false, role: "user" } } as unknown,
  results: {} as Record<string, Result>,
  calls: [] as Call[],
  contacts: [] as unknown[],
  adminRpc: vi.fn(),
  lookupCount: 0 as number | null,
  users: [] as unknown[],
  profiles: [] as unknown[],
  events: vi.fn(),
  trip: { ok: true, data: {} } as unknown,
  owner: null as unknown,
}));

function builder(table: string) {
  const call: Call = { table, op: "select", eqs: [] };
  h.calls.push(call);
  const settle = (): Result => ({ data: null, error: null, ...(h.results[`${table}.${call.op}`] ?? {}) });
  const b: Record<string, unknown> = {};
  for (const m of ["select", "order", "returns"]) b[m] = () => b;
  b.eq = (c: string, v: unknown) => (call.eqs.push([c, v]), b);
  b.delete = () => ((call.op = "delete"), b);
  b.maybeSingle = async () => settle();
  b.then = (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(settle()).then(res, rej);
  return b;
}

vi.mock("./session", () => ({
  getUserSession: async () =>
    h.session
      ? { userId: ME, supabase: { from: builder, rpc: async (name: string) => (name === "share_contacts" ? { data: h.contacts, error: null } : { data: null, error: { code: "x" } }) } }
      : null,
}));
vi.mock("./admin/gate", () => ({
  getAdminSession: async () => (h.isAdmin ? { userId: ME, supabase: {} } : null),
}));
vi.mock("./profile", () => ({ getProfile: async () => h.profile }));
vi.mock("./events", () => ({ logEvent: h.events }));
vi.mock("./ai-usage", () => ({ berlinMidnight: () => new Date("2026-11-04T23:00:00.000Z") }));
vi.mock("./trips", () => ({ getTrip: async () => h.trip }));
vi.mock("./owner-context", () => ({ loadOwnerContext: async () => h.owner }));
vi.mock("./supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) => h.adminRpc(name, args),
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      if (table === "app_events") {
        for (const m of ["select", "eq", "gte"]) q[m] = () => q;
        q.then = (res: (v: unknown) => unknown) =>
          Promise.resolve(h.lookupCount === null ? { count: null, error: { code: "x" } } : { count: h.lookupCount, error: null }).then(res);
      } else {
        for (const m of ["select", "limit", "returns"]) q[m] = () => q;
        q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: h.profiles, error: null }).then(res);
      }
      return q;
    },
    auth: { admin: { listUsers: async () => ({ data: { users: h.users }, error: null }) } },
  }),
}));

import { resetRateLimits } from "./rate-limit";
import {
  getTripOwnerContext,
  leaveShare,
  listGrants,
  listSharedWithMe,
  listShareCandidates,
  setShareAccess,
  shareWith,
  unshare,
} from "./sharing";

const input = (over: Record<string, unknown> = {}) =>
  ({ resource: "trip", resourceId: TRIP, target: { email: EMAIL }, access: "write", ...over }) as never;
const rpcOk = (created = true) => ({ data: [{ share_id: SHARE, created }], error: null });
const shareCalls = () => h.adminRpc.mock.calls.filter((c) => c[0] === "share_resource");
const lookupCalls = () => h.adminRpc.mock.calls.filter((c) => c[0] === "share_user_by_email");
const eventNames = () => h.events.mock.calls.map((c) => c[0].event);

beforeEach(() => {
  resetRateLimits();
  h.session = true;
  h.isAdmin = false;
  h.profile = { ok: true, data: { isDemo: false, role: "user" } };
  h.results = { "trips.select": { data: { owner_id: ME } } };
  h.calls = [];
  h.contacts = [];
  h.lookupCount = 0;
  h.users = [];
  h.profiles = [];
  h.trip = { ok: true, data: {} };
  h.owner = null;
  h.adminRpc.mockReset().mockImplementation(async (name: string) => (name === "share_user_by_email" ? { data: GRANTEE, error: null } : rpcOk()));
  h.events.mockReset();
});

describe("shareWith: who may share", () => {
  it("requires a session, a valid input and a non-demo profile", async () => {
    h.session = false;
    expect(await shareWith(input())).toEqual({ ok: false, error: "unauthenticated" });
    h.session = true;
    expect(await shareWith(input({ access: "owner" }))).toMatchObject({ ok: false, error: "invalid" });
    expect(await shareWith(input({ target: { email: "nope" } }))).toMatchObject({ ok: false, error: "invalid" });
    h.profile = { ok: true, data: { isDemo: true, role: "user" } };
    expect(await shareWith(input())).toEqual({ ok: false, error: "demo_forbidden" });
    expect(h.adminRpc).not.toHaveBeenCalled();
  });

  it("a profile that cannot be read fails closed", async () => {
    h.profile = { ok: false, error: "failed" };
    expect(await shareWith(input())).toEqual({ ok: false, error: "failed" });
    expect(h.adminRpc).not.toHaveBeenCalled();
  });

  it("only the owner: a visible trip of somebody else is forbidden, an invisible one not_found; no lookup, no rpc", async () => {
    h.results["trips.select"] = { data: { owner_id: OWNER } };
    expect(await shareWith(input())).toEqual({ ok: false, error: "forbidden" });
    h.results["trips.select"] = { data: null };
    expect(await shareWith(input())).toEqual({ ok: false, error: "not_found" });
    h.results["trip_purposes.select"] = { data: { owner_id: OWNER } };
    expect(await shareWith(input({ resource: "purpose" }))).toEqual({ ok: false, error: "forbidden" });
    expect(h.adminRpc).not.toHaveBeenCalled();
    expect(h.events).not.toHaveBeenCalled();
  });

  it("reads the resource from the right table through the user session", async () => {
    await shareWith(input());
    h.results["trip_purposes.select"] = { data: { owner_id: ME } };
    await shareWith(input({ resource: "purpose" }));
    expect(h.calls.map((c) => c.table)).toEqual(["trips", "trip_purposes"]);
  });
});

describe("shareWith: finding the recipient", () => {
  it("an unknown email is no_account and writes a sharing.lookup { found: false } event, no share rpc", async () => {
    h.adminRpc.mockImplementation(async () => ({ data: null, error: null }));
    expect(await shareWith(input())).toEqual({ ok: false, error: "no_account" });
    expect(h.events).toHaveBeenCalledWith({ event: "sharing.lookup", userId: ME, props: { found: false } });
    expect(shareCalls()).toHaveLength(0);
  });

  it("a hit logs sharing.lookup { found: true } before the grant", async () => {
    await shareWith(input());
    expect(eventNames()).toEqual(["sharing.lookup", "sharing.granted"]);
    expect(h.events.mock.calls[0][0].props).toEqual({ found: true });
  });

  it("the 21st lookup of the Berlin day is rate_limited, before the lookup answers anything", async () => {
    h.lookupCount = 20;
    expect(await shareWith(input())).toEqual({ ok: false, error: "rate_limited" });
    expect(lookupCalls()).toHaveLength(0);
    h.lookupCount = 19;
    expect(await shareWith(input())).toMatchObject({ ok: true });
  });

  it("an unreadable daily count fails closed", async () => {
    h.lookupCount = null;
    expect(await shareWith(input())).toEqual({ ok: false, error: "failed" });
    expect(lookupCalls()).toHaveLength(0);
  });

  it("the sixth lookup within a minute is rate_limited (in memory)", async () => {
    for (let i = 0; i < 5; i++) expect(await shareWith(input())).toMatchObject({ ok: true });
    expect(await shareWith(input())).toEqual({ ok: false, error: "rate_limited" });
  });

  it("a user id from a non-admin is forbidden, without lookup or rpc", async () => {
    expect(await shareWith(input({ target: { userId: GRANTEE } }))).toEqual({ ok: false, error: "forbidden" });
    expect(h.adminRpc).not.toHaveBeenCalled();
  });

  it("an admin picks from the list: no lookup, no limit, no lookup event; via is list", async () => {
    h.isAdmin = true;
    h.profile = { ok: true, data: { isDemo: false, role: "admin" } };
    h.lookupCount = 999;
    const res = await shareWith(input({ target: { userId: GRANTEE } }));
    expect(res).toMatchObject({ ok: true });
    expect(lookupCalls()).toHaveLength(0);
    expect(shareCalls()[0][1]).toMatchObject({ p_grantee: GRANTEE });
    expect(h.events).toHaveBeenCalledWith({
      event: "sharing.granted",
      userId: ME,
      props: { resource: "trip", resourceId: TRIP, access: "write", via: "list" },
    });
  });
});

describe("shareWith: the share_resource call", () => {
  it("p_owner is always the session user, whatever the client sends", async () => {
    await shareWith(input({ owner: OWNER, ownerId: OWNER, p_owner: OWNER }));
    expect(shareCalls()).toHaveLength(1);
    expect(shareCalls()[0][1]).toEqual({
      p_owner: ME,
      p_resource: "trip",
      p_resource_id: TRIP,
      p_grantee: GRANTEE,
      p_access: "write",
    });
  });

  it("maps every error code of share_resource to its ActionError", async () => {
    const cases: [string, string][] = [
      ["invalid", "invalid"],
      ["forbidden", "forbidden"],
      ["not_found", "not_found"],
      ["self_share", "self_share"],
      ["no_account", "no_account"],
      ["limit_reached", "limit_reached"],
    ];
    for (const [message, error] of cases) {
      resetRateLimits();
      h.adminRpc.mockImplementation(async (name: string) =>
        name === "share_user_by_email" ? { data: GRANTEE, error: null } : { data: null, error: { code: "P0001", message } },
      );
      expect(await shareWith(input())).toEqual({ ok: false, error });
    }
    resetRateLimits();
    h.adminRpc.mockImplementation(async (name: string) =>
      name === "share_user_by_email" ? { data: GRANTEE, error: null } : { data: null, error: { code: "XX000", message: "boom" } },
    );
    expect(await shareWith(input())).toEqual({ ok: false, error: "failed" });
    resetRateLimits();
    h.adminRpc.mockImplementation(async (name: string) =>
      name === "share_user_by_email" ? { data: GRANTEE, error: null } : { data: null, error: { code: "P0001", message: "something else" } },
    );
    expect(await shareWith(input())).toEqual({ ok: false, error: "failed" });
  });

  it("created = true logs sharing.granted, created = false logs sharing.access_changed and not sharing.granted", async () => {
    expect(await shareWith(input())).toEqual({ ok: true, data: { shareId: SHARE, created: true } });
    expect(eventNames()).toContain("sharing.granted");
    h.events.mockReset();
    resetRateLimits();
    h.adminRpc.mockImplementation(async (name: string) => (name === "share_user_by_email" ? { data: GRANTEE, error: null } : rpcOk(false)));
    expect(await shareWith(input())).toEqual({ ok: true, data: { shareId: SHARE, created: false } });
    expect(eventNames()).toContain("sharing.access_changed");
    expect(eventNames()).not.toContain("sharing.granted");
  });

  it("an rpc that throws or answers nothing is failed", async () => {
    h.adminRpc.mockImplementation(async (name: string) => {
      if (name === "share_user_by_email") return { data: GRANTEE, error: null };
      throw new Error("down");
    });
    expect(await shareWith(input())).toEqual({ ok: false, error: "failed" });
    resetRateLimits();
    h.adminRpc.mockImplementation(async (name: string) => (name === "share_user_by_email" ? { data: GRANTEE, error: null } : { data: [], error: null }));
    expect(await shareWith(input())).toEqual({ ok: false, error: "failed" });
  });
});

describe("setShareAccess", () => {
  const row = { id: SHARE, grantee_id: GRANTEE, trip_id: TRIP };

  it("reads the row as its owner only and calls share_resource update-only with that row", async () => {
    h.results["trip_shares.select"] = { data: row };
    expect(await setShareAccess({ resource: "trip", shareId: SHARE, access: "read" })).toEqual({ ok: true });
    expect(h.calls[0].eqs).toEqual([["id", SHARE], ["owner_id", ME]]);
    expect(shareCalls()[0][1]).toEqual({
      p_owner: ME,
      p_resource: "trip",
      p_resource_id: TRIP,
      p_grantee: GRANTEE,
      p_access: "read",
      p_share_id: SHARE,
    });
    expect(h.events).toHaveBeenCalledWith({
      event: "sharing.access_changed",
      userId: ME,
      props: { resource: "trip", resourceId: TRIP, access: "read" },
    });
  });

  it("a row of another owner is not_found without any rpc call", async () => {
    h.results["trip_shares.select"] = { data: null }; // RLS and the owner filter hide it
    expect(await setShareAccess({ resource: "trip", shareId: SHARE, access: "read" })).toEqual({ ok: false, error: "not_found" });
    expect(h.adminRpc).not.toHaveBeenCalled();
    expect(h.events).not.toHaveBeenCalled();
  });

  it("a row that vanished meanwhile answers not_found from the function and creates nothing", async () => {
    h.results["trip_shares.select"] = { data: row };
    h.adminRpc.mockImplementation(async () => ({ data: null, error: { code: "P0001", message: "not_found" } }));
    expect(await setShareAccess({ resource: "trip", shareId: SHARE, access: "read" })).toEqual({ ok: false, error: "not_found" });
    expect(h.events).not.toHaveBeenCalled();
  });

  it("works for purpose shares with the purpose column, and validates its input", async () => {
    h.results["purpose_shares.select"] = { data: { id: SHARE, grantee_id: GRANTEE, purpose_id: TRIP } };
    await setShareAccess({ resource: "purpose", shareId: SHARE, access: "write" });
    expect(h.calls[0].table).toBe("purpose_shares");
    expect(shareCalls()[0][1]).toMatchObject({ p_resource: "purpose", p_resource_id: TRIP });
    expect(await setShareAccess({ resource: "trip", shareId: "x", access: "read" })).toMatchObject({ ok: false, error: "invalid" });
    h.session = false;
    expect(await setShareAccess({ resource: "trip", shareId: SHARE, access: "read" })).toEqual({ ok: false, error: "unauthenticated" });
  });
});

describe("unshare and leaveShare (direct deletes under RLS)", () => {
  it("unshare deletes as the owner; 0 rows is not_found; the event carries ids only", async () => {
    h.results["trip_shares.delete"] = { data: [] };
    expect(await unshare({ resource: "trip", shareId: SHARE })).toEqual({ ok: false, error: "not_found" });
    h.results["trip_shares.delete"] = { data: [{ id: SHARE, trip_id: TRIP }] };
    expect(await unshare({ resource: "trip", shareId: SHARE })).toEqual({ ok: true });
    expect(h.calls[1].eqs).toEqual([["id", SHARE], ["owner_id", ME]]);
    expect(h.events).toHaveBeenCalledWith({ event: "sharing.revoked", userId: ME, props: { resource: "trip", resourceId: TRIP } });
    expect(h.adminRpc).not.toHaveBeenCalled();
  });

  it("leaveShare deletes where grantee = me; 0 rows is not_found", async () => {
    h.results["purpose_shares.delete"] = { data: [] };
    expect(await leaveShare({ resource: "purpose", shareId: SHARE })).toEqual({ ok: false, error: "not_found" });
    h.results["purpose_shares.delete"] = { data: [{ id: SHARE, purpose_id: TRIP }] };
    expect(await leaveShare({ resource: "purpose", shareId: SHARE })).toEqual({ ok: true });
    expect(h.calls[1].eqs).toEqual([["id", SHARE], ["grantee_id", ME]]);
    expect(h.events).toHaveBeenCalledWith({ event: "sharing.left", userId: ME, props: { resource: "purpose", resourceId: TRIP } });
  });

  it("validate input and session; a database error is failed", async () => {
    expect(await unshare({ resource: "group" as never, shareId: SHARE })).toMatchObject({ ok: false, error: "invalid" });
    expect(await leaveShare({ resource: "trip", shareId: "x" })).toMatchObject({ ok: false, error: "invalid" });
    h.results["trip_shares.delete"] = { error: { code: "XX000" } };
    expect(await unshare({ resource: "trip", shareId: SHARE })).toEqual({ ok: false, error: "failed" });
    h.session = false;
    expect(await leaveShare({ resource: "trip", shareId: SHARE })).toEqual({ ok: false, error: "unauthenticated" });
  });
});

describe("events never carry emails, names or titles", () => {
  it("across a full round of actions", async () => {
    h.contacts = [{ user_id: GRANTEE, display_name: "Carol Secret", email: EMAIL }];
    h.results["trip_shares.select"] = { data: { id: SHARE, grantee_id: GRANTEE, trip_id: TRIP } };
    h.results["trip_shares.delete"] = { data: [{ id: SHARE, trip_id: TRIP }] };
    await shareWith(input());
    resetRateLimits();
    h.adminRpc.mockImplementation(async (name: string) => (name === "share_user_by_email" ? { data: null, error: null } : rpcOk()));
    await shareWith(input()); // a miss
    await setShareAccess({ resource: "trip", shareId: SHARE, access: "read" });
    await unshare({ resource: "trip", shareId: SHARE });
    await leaveShare({ resource: "trip", shareId: SHARE });
    const text = JSON.stringify(h.events.mock.calls);
    expect(text).not.toMatch(/carol|secret|example\.com|@/i);
    for (const [e] of h.events.mock.calls) {
      expect(e.event).toMatch(/^sharing\./);
      for (const v of Object.values(e.props as Record<string, unknown>)) expect(["string", "boolean", "number"]).toContain(typeof v);
    }
  });
});

describe("listGrants", () => {
  it("owner only: somebody else's resource is forbidden, an invisible one not_found", async () => {
    h.results["trips.select"] = { data: { owner_id: OWNER } };
    expect(await listGrants("trip", TRIP)).toEqual({ ok: false, error: "forbidden" });
    h.results["trips.select"] = { data: null };
    expect(await listGrants("trip", TRIP)).toEqual({ ok: false, error: "not_found" });
    expect(await listGrants("trip", "x")).toEqual({ ok: false, error: "invalid" });
    expect(await listGrants("group" as never, TRIP)).toEqual({ ok: false, error: "invalid" });
  });

  it("returns the grants with name and email from share_contacts", async () => {
    h.results["trip_shares.select"] = { data: [{ id: SHARE, grantee_id: GRANTEE, access: "write", created_at: "2026-11-01T00:00:00Z" }] };
    h.contacts = [{ user_id: GRANTEE, display_name: "Carol", email: EMAIL }];
    expect(await listGrants("trip", TRIP)).toEqual({
      ok: true,
      data: [{ id: SHARE, grantee: { id: GRANTEE, name: "Carol", email: EMAIL }, access: "write", createdAt: "2026-11-01T00:00:00Z" }],
    });
  });
});

describe("listSharedWithMe", () => {
  const tripRow = {
    id: "dest", owner_id: OWNER, title: null, dest_kind: "freetext", dest_name: "Alpen", dest_place_name: null, dest_geo_id: null,
    dest_country_code: null, dest_admin1: null, dest_lat: null, dest_lon: null, dest_timezone: null, dest_radius_km: null,
    length_days: 3, start_date: null, months: [], group_id: null, group_text: null, group_structure: null, group_parsed: null,
    group_parsed_hash: null, purpose_id: null, wants_flights: false, origin_airports: [], notes: null, destination_search_id: null,
    created_at: "c", updated_at: "u", travel_groups: { name: "Family" }, trip_purposes: null,
  };
  const purposeRow = {
    id: "p1", owner_id: OWNER, name: "Golf", text: null, guided: {}, constraints: [], parsed_tags: null, parsed_hash: null,
    created_at: "c", updated_at: "u",
  };

  it("maps trips and purposes with the owner, the level and the viewer's access; newest first", async () => {
    h.contacts = [{ user_id: OWNER, display_name: "Olga", email: "olga@example.com" }];
    h.results["trip_shares.select"] = { data: [{ id: "s-trip", trip_id: "dest", owner_id: OWNER, access: "read", created_at: "2026-11-01T00:00:00Z", trips: tripRow }] };
    h.results["purpose_shares.select"] = { data: [{ id: "s-purpose", purpose_id: "p1", owner_id: OWNER, access: "write", created_at: "2026-11-02T00:00:00Z", trip_purposes: purposeRow }] };
    const res = await listSharedWithMe();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((s) => s.id)).toEqual(["s-purpose", "s-trip"]);
    const person = { id: OWNER, name: "Olga", email: "olga@example.com" };
    expect(res.data[1]).toMatchObject({
      resource: "trip",
      resourceId: "dest",
      owner: person,
      access: "read",
      purpose: null,
      trip: { id: "dest", access: "read", sharedBy: person, shareCount: 0, groupName: "Family" },
    });
    expect(res.data[0]).toMatchObject({
      resource: "purpose",
      access: "write",
      trip: null,
      purpose: { id: "p1", ownerId: OWNER, access: "write", usable: true },
    });
    expect(h.calls.map((c) => c.table).sort()).toEqual(["purpose_shares", "trip_shares"]);
    expect(h.calls.every((c) => c.eqs.some(([k, v]) => k === "grantee_id" && v === ME))).toBe(true);
  });

  it("skips shares whose resource cannot be read and fails when a read fails", async () => {
    h.results["trip_shares.select"] = { data: [{ id: "s", trip_id: "dest", owner_id: OWNER, access: "read", created_at: "c", trips: null }] };
    h.results["purpose_shares.select"] = { data: [] };
    expect(await listSharedWithMe()).toEqual({ ok: true, data: [] });
    h.results["purpose_shares.select"] = { error: { code: "x" } };
    expect(await listSharedWithMe()).toEqual({ ok: false, error: "failed" });
    h.session = false;
    expect(await listSharedWithMe()).toEqual({ ok: false, error: "unauthenticated" });
  });
});

describe("listShareCandidates (admin only)", () => {
  it("a non-admin is forbidden and nothing is read", async () => {
    expect(await listShareCandidates()).toEqual({ ok: false, error: "forbidden" });
  });

  it("lists active users except self, the demo account and disabled accounts, with email and name only", async () => {
    h.isAdmin = true;
    h.users = [
      { id: ME, email: "me@example.com" },
      { id: GRANTEE, email: "zed@example.com" },
      { id: OWNER, email: "amy@example.com" },
      { id: "dddddddd-0000-4000-8000-000000000004", email: "demo@example.com" },
      { id: "eeeeeeee-0000-4000-8000-000000000005", email: "off@example.com" },
      { id: "ffffffff-0000-4000-8000-000000000006", email: null },
    ];
    h.profiles = [
      { id: ME, display_name: "Me", is_demo: false, disabled_at: null },
      { id: GRANTEE, display_name: "Zed", is_demo: false, disabled_at: null },
      { id: OWNER, display_name: null, is_demo: false, disabled_at: null },
      { id: "dddddddd-0000-4000-8000-000000000004", display_name: "Demo", is_demo: true, disabled_at: null },
      { id: "eeeeeeee-0000-4000-8000-000000000005", display_name: "Off", is_demo: false, disabled_at: "2026-11-01T00:00:00Z" },
    ];
    expect(await listShareCandidates()).toEqual({
      ok: true,
      data: [
        { id: OWNER, email: "amy@example.com", name: null },
        { id: GRANTEE, email: "zed@example.com", name: "Zed" },
      ],
    });
  });
});

describe("getTripOwnerContext", () => {
  const trip = (access: string) => ({
    ok: true,
    data: { id: TRIP, ownerId: OWNER, access, timing: { kind: "date", startDate: "2030-06-15" }, lengthDays: 5 },
  });

  it("returns the owner's person and the age on the travel date, never the birthdate", async () => {
    h.trip = trip("read");
    h.contacts = [{ user_id: OWNER, display_name: "Olga", email: "olga@example.com" }];
    h.owner = { birthdate: "1990-06-16", homeAirports: [], locale: "de", displayName: "Olga" };
    const res = await getTripOwnerContext(TRIP);
    expect(res).toEqual({ ok: true, data: { owner: { id: OWNER, name: "Olga", email: "olga@example.com" }, ownerAge: 39 } });
    expect(JSON.stringify(res)).not.toContain("1990");
  });

  it("no birthdate means no age; an invisible trip is not_found; an unreadable owner fails closed", async () => {
    h.trip = trip("write");
    h.owner = { birthdate: null, homeAirports: [], locale: "de", displayName: "Olga" };
    expect(await getTripOwnerContext(TRIP)).toMatchObject({ ok: true, data: { ownerAge: null } });
    h.trip = { ok: false, error: "not_found" };
    expect(await getTripOwnerContext(TRIP)).toEqual({ ok: false, error: "not_found" });
    h.trip = trip("write");
    h.owner = null;
    expect(await getTripOwnerContext(TRIP)).toEqual({ ok: false, error: "failed" });
  });
});
