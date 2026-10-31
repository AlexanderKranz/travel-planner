import { beforeEach, describe, expect, it, vi } from "vitest";
import golf from "./__fixtures__/plan-document-golf.json";
import itemsGolf from "@/lib/items/__fixtures__/items-golf.json";

vi.mock("server-only", () => ({}));

type Call = { table: string; select: string };
const calls: Call[] = [];
const rpcs: { fn: string; args: unknown }[] = [];
const events: { event: string; props?: Record<string, unknown> }[] = [];
let tables: Record<string, unknown> = {};
let tableErrors: Record<string, { code: string }> = {};

function builder(table: string) {
  const b: Record<string, unknown> = {};
  const result = () => ({ data: tables[table] ?? null, error: tableErrors[table] ?? null });
  for (const m of ["eq", "order", "returns", "limit"]) b[m] = () => b;
  b.select = (cols: string) => {
    calls.push({ table, select: cols });
    return b;
  };
  b.maybeSingle = async () => result();
  b.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
  return b;
}
vi.mock("./supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: unknown) => {
      rpcs.push({ fn, args });
      return { data: null, error: null };
    },
  }),
}));
vi.mock("./events", () => ({ logEvent: async (e: { event: string; props?: Record<string, unknown> }) => void events.push(e) }));
vi.mock("./session", () => ({ getUserSession: async () => null }));

import { buildPlanDocument, getSharedPlanDocument } from "./plan-document";
import { hashShareToken } from "./share-token";

const TOKEN = "A".repeat(43);
const plan = (golf as unknown as { plan: unknown }).plan;
const link = (o: Record<string, unknown> = {}) => ({
  id: "L1", owner_id: "U1", trip_id: "T1", include_items: true, include_item_notes: false, expires_at: null, ...o,
});
const itemRows = (itemsGolf as unknown as Record<string, unknown>[]).map((i) => ({
  id: i.id, category: i.category, title: i.title, status: i.status, price_cents: i.priceCents, price_basis: i.priceBasis,
  persons: i.persons, currency: i.currency, day: i.day, ref: i.ref, url: i.url, notes: "SECRET-CODE",
}));

beforeEach(() => {
  calls.length = 0;
  rpcs.length = 0;
  tableErrors = {};
  events.length = 0;
  tables = {
    share_links: link(),
    profiles: { disabled_at: null },
    plans: { id: "P1", latest_version: 3, open_done: ["abcd1234"] },
    plan_versions: { plan, version_no: 3, created_at: "2026-10-01T00:00:00Z" },
    trip_items: itemRows,
    trips: { group_id: "G1", group_text: null, group_structure: null, group_parsed: null, group_parsed_hash: null },
    travel_groups: { description: null, parsed_structure: null, parsed_hash: null },
    group_entries: [{ kind: "composition", count: 2 }],
  };
});

describe("getSharedPlanDocument", () => {
  it("uses explicit column lists only", async () => {
    const doc = await getSharedPlanDocument(TOKEN, "page");
    expect(doc).not.toBeNull();
    expect(calls).toEqual([
      { table: "share_links", select: "id, owner_id, trip_id, include_items, include_item_notes, expires_at" },
      { table: "profiles", select: "disabled_at, home_location, home_timezone" },
      { table: "plans", select: "id, latest_version, open_done" },
      { table: "plan_versions", select: "plan, version_no, created_at" },
      {
        table: "trip_items",
        select: "id, category, title, status, price_cents, price_basis, persons, currency, day, ref, url, start_time, end_time",
      },
      { table: "trips", select: "group_id, group_text, group_structure, group_parsed, group_parsed_hash" },
      { table: "travel_groups", select: "description, parsed_structure, parsed_hash" },
      { table: "group_entries", select: "kind, count" },
    ]);
    expect(calls.some((c) => c.select.includes("*"))).toBe(false);
  });
  it("exposes only the computed time difference, not the owner's zone or profile", async () => {
    tables.profiles = { disabled_at: null, home_location: "Bangkok", home_timezone: "Asia/Bangkok", display_name: "Secret" };
    const doc = await getSharedPlanDocument(TOKEN, "page");
    expect(doc!.timeDifference).toEqual({ kind: "behind", hours: "6", home: "Bangkok", notes: [] });
    const dump = JSON.stringify(doc);
    expect(dump).not.toContain("Asia/Bangkok");
    expect(dump).not.toContain("Secret");
  });
  it("omits the time difference when it is zero (Madrid vs. default Germany)", async () => {
    const doc = await getSharedPlanDocument(TOKEN, "page");
    expect(doc!.timeDifference).toBeNull();
  });
  it("hides item notes unless the link allows them", async () => {
    const without = await getSharedPlanDocument(TOKEN, "page");
    expect(JSON.stringify(without)).not.toContain("SECRET-CODE");
    tables.share_links = link({ include_item_notes: true });
    calls.length = 0;
    await getSharedPlanDocument(TOKEN, "page");
    expect(calls.find((c) => c.table === "trip_items")!.select.endsWith(", notes")).toBe(true);
    const withNotes = await getSharedPlanDocument(TOKEN, "page");
    expect(withNotes!.items![0]!.notes).toBe("SECRET-CODE");
  });
  it("computes costs with the party size", async () => {
    const doc = await getSharedPlanDocument(TOKEN, "page");
    expect(doc!.costs!.partySize).toBe(2);
    expect(doc!.costs!.currencies[0]!.booked.perPersonCents).toBe(120964);
  });
  it("include_items=false queries no items, trip or group", async () => {
    tables.share_links = link({ include_items: false });
    const doc = await getSharedPlanDocument(TOKEN, "page");
    expect(doc!.items).toBeNull();
    expect(doc!.costs).toBeNull();
    expect(calls.map((c) => c.table)).toEqual(["share_links", "profiles", "plans", "plan_versions"]);
  });
  it("touches the link and logs a view without token, hash or IP", async () => {
    await getSharedPlanDocument(TOKEN, "pdf");
    expect(rpcs).toEqual([{ fn: "share_link_touch", args: { p_id: "L1" } }]);
    expect(events).toEqual([{ event: "share.viewed", userId: "U1", props: { linkId: "L1", via: "pdf" } }]);
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(hashShareToken(TOKEN));
  });
  it("returns null for bad format without any DB call", async () => {
    expect(await getSharedPlanDocument("short", "page")).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it("serves the link while the disabled_at column does not exist yet (deploy gap)", async () => {
    tables.profiles = null;
    tableErrors.profiles = { code: "42703" };
    expect(await getSharedPlanDocument(TOKEN, "page")).not.toBeNull();
  });
  it.each([
    ["unknown token", () => (tables.share_links = null)],
    ["expired", () => (tables.share_links = link({ expires_at: "2000-01-01T00:00:00Z" }))],
    ["disabled owner", () => (tables.profiles = { disabled_at: "2026-10-31T10:00:00Z" })],
    ["owner flag unreadable (fails closed)", () => (tables.profiles = null)],
    ["no plan", () => (tables.plans = null)],
    ["plan without version", () => (tables.plans = { id: "P1", latest_version: 0, open_done: [] })],
    ["missing version", () => (tables.plan_versions = null)],
    ["owner flag read error (fails closed)", () => (tableErrors.profiles = { code: "08006" })],
  ])("%s gives null and no view", async (_n, arrange) => {
    arrange();
    expect(await getSharedPlanDocument(TOKEN, "page")).toBeNull();
    expect(rpcs).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
  it("invalid stored plan gives null and an error event", async () => {
    tables.plan_versions = { plan: { v: 2 }, version_no: 3, created_at: "x" };
    expect(await getSharedPlanDocument(TOKEN, "page")).toBeNull();
    expect(events.map((e) => e.event)).toEqual(["share.invalid_plan"]);
  });
});

describe("buildPlanDocument", () => {
  it("drops reserved items/costs keys of the plan", () => {
    const p = { ...(plan as object), items: [1], costs: { x: 1 } } as never;
    const doc = buildPlanDocument({ plan: p, versionNo: 1, versionAt: "x", openDone: [], items: null, partySize: null });
    expect("items" in doc.plan).toBe(false);
    expect("costs" in doc.plan).toBe(false);
  });
});
