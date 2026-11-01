import { beforeEach, describe, expect, it, vi } from "vitest";
import golf from "./__fixtures__/plan-document-golf.json";
import type { Plan } from "@/lib/domain/plan";

vi.mock("server-only", () => ({}));

const selects: string[] = [];
const admin = vi.fn();
let tables: Record<string, unknown> = {};
let errors: Record<string, unknown> = {};

function builder(table: string) {
  const b: Record<string, unknown> = {};
  const result = () => ({ data: tables[table] ?? null, error: errors[table] ?? null });
  for (const m of ["eq", "order", "returns", "limit"]) b[m] = () => b;
  b.select = (cols: string) => {
    selects.push(`${table}:${cols}`);
    return b;
  };
  b.maybeSingle = async () => result();
  b.then = (res: (v: unknown) => unknown) => Promise.resolve(result()).then(res);
  return b;
}
vi.mock("./supabase/admin", () => ({ createSupabaseAdminClient: () => (admin(), {}) }));
vi.mock("./events", () => ({ logEvent: async () => {} }));
vi.mock("./session", () => ({ getUserSession: async () => ({ userId: "U1", supabase: { from: builder } }) }));

import { getOwnerPlanDocumentResult } from "./plan-document";

const TRIP = "11111111-1111-4111-8111-111111111111";
const plan = (golf as unknown as { plan: Plan }).plan;
const from = (table: string) => selects.filter((s) => s.startsWith(`${table}:`));

beforeEach(() => {
  selects.length = 0;
  admin.mockClear();
  errors = {};
  tables = {
    trips: {
      group_id: null, group_text: "2 Erwachsene", group_structure: null, group_parsed: null, group_parsed_hash: null,
      dest_name: "Costa del Sol", dest_country_code: "ES", dest_lat: 36.7, dest_lon: -4.4, dest_timezone: "Europe/Madrid",
    },
    plans: { id: "P1", latest_version: 3, open_done: ["abcd1234"] },
    plan_versions: { plan, version_no: 3, created_at: "2026-10-01T00:00:00Z" },
    trip_items: [],
    profiles: { home_location: "Bangkok", home_timezone: "Asia/Bangkok" },
  };
});

describe("getOwnerPlanDocumentResult", () => {
  it("reads everything with the user session and never the admin client", async () => {
    const res = await getOwnerPlanDocumentResult(TRIP);
    expect(res.ok).toBe(true);
    expect(from("plan_versions")).toHaveLength(1);
    expect(from("profiles")).toHaveLength(1);
    expect(admin).not.toHaveBeenCalled();
  });

  it("reuses the version and the home place the page already holds", async () => {
    const res = await getOwnerPlanDocumentResult(TRIP, {
      latest: { plan, versionNo: 3, versionAt: "2026-10-05T00:00:00Z" },
      home: { name: "Bangkok", timezone: "Asia/Bangkok" },
    });
    expect(res.ok && res.doc.versionNo).toBe(3);
    expect(res.ok && res.doc.versionAt).toBe("2026-10-05T00:00:00Z");
    expect(res.ok && res.doc.timeDifference).toEqual({ kind: "behind", hours: "6", home: "Bangkok", notes: [] });
    expect(from("plan_versions")).toHaveLength(0);
    expect(from("profiles")).toHaveLength(0);
  });

  it("ignores a known version that is no longer the latest and reads the real one", async () => {
    const res = await getOwnerPlanDocumentResult(TRIP, { latest: { plan, versionNo: 2, versionAt: "2026-09-01T00:00:00Z" } });
    expect(res.ok && res.doc.versionNo).toBe(3);
    expect(from("plan_versions")).toHaveLength(1);
  });

  it("keeps the error order: destination, plan row, no plan, version, items", async () => {
    errors = { trips: { code: "x" }, plans: { code: "x" } };
    expect(await getOwnerPlanDocumentResult(TRIP)).toEqual({ ok: false, error: "failed" });
    errors = {};
    tables.trips = null;
    expect(await getOwnerPlanDocumentResult(TRIP)).toEqual({ ok: false, error: "not_found" });
    tables.trips = { group_text: null, dest_name: "X" };
    tables.plans = { id: "P1", latest_version: 0, open_done: [] };
    expect(await getOwnerPlanDocumentResult(TRIP)).toEqual({ ok: false, error: "no_plan" });
    tables.plans = null;
    expect(await getOwnerPlanDocumentResult(TRIP)).toEqual({ ok: false, error: "no_plan" });
    tables.plans = { id: "P1", latest_version: 3, open_done: [] };
    tables.plan_versions = { plan: { nope: 1 }, version_no: 3, created_at: "x" };
    expect(await getOwnerPlanDocumentResult(TRIP)).toEqual({ ok: false, error: "failed" });
    tables.plan_versions = { plan, version_no: 3, created_at: "x" };
    errors = { trip_items: { code: "x" } };
    expect(await getOwnerPlanDocumentResult(TRIP)).toEqual({ ok: false, error: "failed" });
  });

  it("a failed profile read only drops the time difference", async () => {
    errors = { profiles: { code: "x" } };
    const res = await getOwnerPlanDocumentResult(TRIP);
    expect(res.ok && res.doc.timeDifference).toBeNull();
  });

  it("a malformed trip id is not_found without any read", async () => {
    expect(await getOwnerPlanDocumentResult("nope")).toEqual({ ok: false, error: "not_found" });
    expect(selects).toHaveLength(0);
  });
});
