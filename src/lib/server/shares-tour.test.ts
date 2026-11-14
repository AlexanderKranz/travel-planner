import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { Op, Reply } from "./tour/test-db";

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  reply: (() => ({})) as (op: Op) => Reply,
  isDemo: false,
  locale: "de" as "de" | "en",
  events: [] as { event: string; props?: Record<string, unknown> }[],
}));
vi.mock("./session", async () => {
  const { fakeDb } = await import("./tour/test-db");
  return { getUserSession: async () => ({ userId: "u1", supabase: fakeDb("user", h.ops, (o) => h.reply(o)) }) };
});
vi.mock("./supabase/admin", async () => {
  const { fakeDb } = await import("./tour/test-db");
  return { createSupabaseAdminClient: () => fakeDb("admin", h.ops, (o) => h.reply(o)) };
});
vi.mock("./profile", () => ({ getProfile: async () => ({ ok: true, data: { isDemo: h.isDemo, locale: h.locale } }) }));
vi.mock("./app-url", () => ({ getAppUrl: () => "https://app.test" }));
vi.mock("./events", () => ({ logEvent: async (e: { event: string; props?: Record<string, unknown> }) => void h.events.push(e) }));
vi.mock("./plan-store", () => ({ getPlanRow: async () => null, getVersion: async () => null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { resetRateLimits } from "./rate-limit";
import { createTourShareLink, listTourShareLinks } from "./shares";

const TOUR = "11111111-1111-4111-8111-111111111111";
const linkRow = (p: Record<string, unknown>) => ({
  id: "L1", trip_id: null, tour_id: TOUR, label: p.label ?? null, include_items: false, include_item_notes: false,
  expires_at: p.expires_at ?? null, view_count: 0, last_viewed_at: null, created_at: "2026-11-14T00:00:00Z",
});

beforeEach(() => {
  resetRateLimits();
  h.ops = [];
  h.isDemo = false;
  h.locale = "de";
  h.events = [];
  h.reply = (o) => {
    if (o.table === "city_tours") return { data: { id: TOUR, owner_id: "u1", result: { v: 1 } } };
    if (o.table === "share_links" && o.head) return { count: 0 };
    if (o.table === "share_links" && o.op === "insert") return { data: linkRow(o.payload as Record<string, unknown>) };
    if (o.table === "share_links") return { data: [] };
    return {};
  };
});

describe("createTourShareLink (city-tour 9.3)", () => {
  it("owner: writes the link with the secret key, owner from the session, no items; URL in the owner's language", async () => {
    const res = await createTourShareLink(TOUR, { label: " Altstadt ", expiresInDays: 30 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.url).toMatch(/^https:\/\/app\.test\/de\/s\/[A-Za-z0-9_-]+$/);
    expect(res.data.link).toMatchObject({ tourId: TOUR, tripId: null });
    const insert = h.ops.find((o) => o.op === "insert")!;
    expect(insert.client).toBe("admin");
    expect(insert.payload).toMatchObject({ owner_id: "u1", tour_id: TOUR, include_items: false, include_item_notes: false, label: "Altstadt" });
    expect(insert.payload).not.toHaveProperty("trip_id");
    // The tour was read through the user's session (RLS) before the secret-key write.
    expect(h.ops.findIndex((o) => o.client === "user" && o.table === "city_tours")).toBeLessThan(h.ops.indexOf(insert));
    expect(h.events).toContainEqual(expect.objectContaining({ event: "share.created", props: expect.objectContaining({ kind: "tour" }) }));
  });

  it("the URL follows the owner's language, not a fixed one", async () => {
    h.locale = "en";
    const res = await createTourShareLink(TOUR, { label: null, expiresInDays: null });
    expect(res.ok && res.data.url).toMatch(/^https:\/\/app\.test\/en\/s\//);
  });

  it("not the owner (also a write grantee): forbidden, nothing written", async () => {
    const base = h.reply;
    h.reply = (o) => (o.table === "city_tours" ? { data: { id: TOUR, owner_id: "u2", result: { v: 1 } } } : base(o));
    expect(await createTourShareLink(TOUR, { label: null, expiresInDays: null })).toEqual({ ok: false, error: "forbidden" });
    expect(h.ops.some((o) => o.op === "insert")).toBe(false);
  });

  it("refuses the demo account, an uncomputed tour, an invisible tour and too many links", async () => {
    h.isDemo = true;
    expect(await createTourShareLink(TOUR, { label: null, expiresInDays: null })).toEqual({ ok: false, error: "demo_forbidden" });
    h.isDemo = false;
    const base = h.reply;
    h.reply = (o) => (o.table === "city_tours" ? { data: { id: TOUR, owner_id: "u1", result: null } } : base(o));
    expect(await createTourShareLink(TOUR, { label: null, expiresInDays: null })).toEqual({ ok: false, error: "no_plan" });
    h.reply = (o) => (o.table === "city_tours" ? { data: null } : base(o));
    expect(await createTourShareLink(TOUR, { label: null, expiresInDays: null })).toEqual({ ok: false, error: "not_found" });
    h.reply = (o) => (o.table === "share_links" && o.head ? { count: 10 } : base(o));
    expect(await createTourShareLink(TOUR, { label: null, expiresInDays: null })).toEqual({ ok: false, error: "limit_reached" });
    expect(h.ops.some((o) => o.op === "insert")).toBe(false);
  });

  it("validates its input", async () => {
    expect(await createTourShareLink("nope", { label: null, expiresInDays: null })).toMatchObject({ ok: false, error: "invalid" });
    expect(await createTourShareLink(TOUR, { label: null, expiresInDays: 3 })).toMatchObject({ ok: false, error: "invalid" });
  });
});

describe("listTourShareLinks", () => {
  it("reads the links of the tour through the session (RLS: owner only)", async () => {
    const res = await listTourShareLinks(TOUR);
    expect(res).toEqual({ ok: true, data: [] });
    expect(h.ops[0]).toMatchObject({ client: "user", table: "share_links" });
    expect(h.ops[0].eqs).toContainEqual(["tour_id", TOUR]);
  });
});
