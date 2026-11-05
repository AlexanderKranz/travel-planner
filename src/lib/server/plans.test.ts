import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  tripRow: null as unknown,
  updates: [] as unknown[],
}));
vi.mock("./session", () => ({
  getUserSession: async () => ({
    userId: "U",
    supabase: {
      from: (table: string) => {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq"]) b[m] = () => b;
        b.maybeSingle = async () => ({ data: table === "trips" ? h.tripRow : { id: "P", latest_version: 0, open_done: [] }, error: null });
        b.update = (p: unknown) => (h.updates.push(p), b);
        return b;
      },
    },
  }),
}));
vi.mock("./plan-store", () => ({ getVersionLight: async () => null }));
vi.mock("./plan-pipeline", () => ({ editPlanVersion: vi.fn(), loadPlanContext: vi.fn(), loadPlanState: vi.fn(), restoreVersion: vi.fn() }));

import { toggleOpenItem } from "./plans";

const TRIP = "11111111-1111-4111-8111-111111111111";
const KEY = "abcd1234";

beforeEach(() => {
  h.updates.length = 0;
});

describe("toggleOpenItem access (sharing spec 1.1)", () => {
  it("a read grantee is forbidden, nothing is written", async () => {
    h.tripRow = { owner_id: "owner", trip_shares: [{ grantee_id: "U", access: "read" }] };
    expect(await toggleOpenItem(TRIP, KEY, true)).toEqual({ ok: false, error: "forbidden" });
    expect(h.updates).toEqual([]);
  });
  it("a trip that is not visible is not_found", async () => {
    h.tripRow = null;
    expect(await toggleOpenItem(TRIP, KEY, true)).toEqual({ ok: false, error: "not_found" });
  });
  it("the owner and a write grantee get past the gate (here: no plan version yet)", async () => {
    h.tripRow = { owner_id: "U", trip_shares: [] };
    expect(await toggleOpenItem(TRIP, KEY, true)).toEqual({ ok: false, error: "no_plan" });
    h.tripRow = { owner_id: "owner", trip_shares: [{ grantee_id: "U", access: "write" }] };
    expect(await toggleOpenItem(TRIP, KEY, true)).toEqual({ ok: false, error: "no_plan" });
  });
});
