import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

let isDemo = false;
let plan: { id: string; latestVersion: number } | null = { id: "P1", latestVersion: 2 };
let activeLinks = 0;
let inserted: Record<string, unknown> | null = null;
const events: string[] = [];

function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["eq", "or", "order", "returns"]) b[m] = () => b;
  b.select = (_c: string, opts?: { head?: boolean }) => {
    if (opts?.head) {
      const t: Record<string, unknown> = { then: (r: (v: unknown) => unknown) => Promise.resolve({ count: activeLinks, error: null }).then(r) };
      t.eq = () => t;
      t.or = () => t;
      return t;
    }
    return b;
  };
  b.maybeSingle = async () => ({ data: table === "trips" ? { id: "T1" } : null, error: null });
  b.insert = (row: Record<string, unknown>) => {
    inserted = row;
    return {
      select: () => ({
        single: async () => ({
          data: {
            id: "L1", trip_id: "T1", label: row.label, include_items: row.include_items,
            include_item_notes: row.include_item_notes, expires_at: row.expires_at, view_count: 0,
            last_viewed_at: null, created_at: "2026-10-28T00:00:00Z",
          },
          error: null,
        }),
      }),
    };
  };
  return b;
}
vi.mock("./session", () => ({ getUserSession: async () => ({ userId: "U1", supabase: { from: builder } }) }));
vi.mock("./profile", () => ({ getProfile: async () => ({ ok: true, data: { isDemo } }) }));
vi.mock("./plan-store", () => ({
  getPlanRow: async () => plan,
  getVersion: async () => ({ plan: { locale: "de" } }),
}));
vi.mock("./app-url", () => ({ getAppUrl: () => "https://app.test" }));
vi.mock("./events", () => ({ logEvent: async (e: { event: string }) => void events.push(e.event) }));

import { resetRateLimits } from "./rate-limit";
import { createShareLink } from "./shares";

const TRIP = "11111111-1111-4111-8111-111111111111";
const input = { label: "Ben", expiresInDays: 7, includeItems: true };

beforeEach(() => {
  isDemo = false;
  plan = { id: "P1", latestVersion: 2 };
  activeLinks = 0;
  inserted = null;
  events.length = 0;
  resetRateLimits();
});

describe("createShareLink", () => {
  it("demo account is forbidden", async () => {
    isDemo = true;
    expect(await createShareLink(TRIP, input)).toEqual({ ok: false, error: "demo_forbidden" });
    expect(inserted).toBeNull();
  });
  it("no plan version gives no_plan", async () => {
    plan = { id: "P1", latestVersion: 0 };
    expect(await createShareLink(TRIP, input)).toEqual({ ok: false, error: "no_plan" });
  });
  it("10 active links give limit_reached", async () => {
    activeLinks = 10;
    expect(await createShareLink(TRIP, input)).toEqual({ ok: false, error: "limit_reached" });
  });
  it("rejects invalid input", async () => {
    const r = await createShareLink(TRIP, { ...input, expiresInDays: 5 });
    expect(r).toMatchObject({ ok: false, error: "invalid" });
  });
  it("url holds the token; the insert holds only the hash", async () => {
    const r = await createShareLink(TRIP, { ...input, includeItemNotes: true });
    if (!r.ok) throw new Error("expected ok");
    const token = r.data.url.split("/s/")[1]!;
    expect(r.data.url).toBe(`https://app.test/de/s/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inserted!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(inserted)).not.toContain(token);
    expect(inserted!.include_item_notes).toBe(true);
    expect(JSON.stringify(r.data.link)).not.toContain(token);
    expect(events).toEqual(["share.created"]);
  });
  it("item notes need items", async () => {
    await createShareLink(TRIP, { ...input, includeItems: false, includeItemNotes: true });
    expect(inserted!.include_item_notes).toBe(false);
  });
  it("rate limits at 10 per minute", async () => {
    let last;
    for (let i = 0; i < 11; i++) last = await createShareLink(TRIP, input);
    expect(last).toEqual({ ok: false, error: "rate_limited" });
  });
});
