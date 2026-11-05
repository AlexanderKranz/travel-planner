import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/plan/hash", () => ({ purposeTagsHash: () => "h1" }));

type Result = { data?: unknown; error?: { code: string } | null };
const h = vi.hoisted(() => ({
  results: {} as Record<string, Result>, // key: `${op}` of trip_purposes
  ops: [] as { op: string; payload?: unknown; eqs: [string, unknown][] }[],
  warm: vi.fn(),
  logEvent: vi.fn(),
}));

function builder() {
  let op = "select";
  let payload: unknown;
  const eqs: [string, unknown][] = [];
  const b: Record<string, unknown> = {};
  const settle = (): Result => {
    h.ops.push({ op, payload, eqs });
    return { data: null, error: null, ...(h.results[op] ?? {}) };
  };
  for (const m of ["select", "order", "returns"]) b[m] = () => b;
  b.eq = (c: string, v: unknown) => (eqs.push([c, v]), b);
  b.update = (p: unknown) => ((op = "update"), (payload = p), b);
  b.maybeSingle = async () => settle();
  b.then = (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(settle()).then(res, rej);
  return b;
}

vi.mock("./session", () => ({ getUserSession: async () => ({ userId: "u1", supabase: { from: builder } }) }));
vi.mock("./events", () => ({ logEvent: h.logEvent }));
vi.mock("./warm", () => ({ schedulePurposeWarm: h.warm }));

import { resetRateLimits } from "./rate-limit";
import { listPurposes, updatePurpose } from "./purposes";

const ID = "11111111-1111-4111-8111-111111111111";
const row = (o: Record<string, unknown> = {}) => ({
  id: ID, owner_id: "u1", name: "Golf", text: "t", guided: {}, constraints: [], parsed_tags: null, parsed_hash: null,
  created_at: "c", updated_at: "2026-11-01T00:00:00Z", purpose_shares: [], ...o,
});
const input = { name: "Golf 2", text: "new", guided: {}, constraints: [] };
const updateOp = () => h.ops.find((o) => o.op === "update");

beforeEach(() => {
  resetRateLimits();
  h.results = {};
  h.ops = [];
  h.warm.mockReset();
  h.logEvent.mockReset();
});

describe("listPurposes means mine", () => {
  it("filters by owner (RLS also returns shared purposes and purposes seen through a shared trip)", async () => {
    h.results.select = { data: [row()] };
    const res = await listPurposes();
    expect(res).toMatchObject({ ok: true, data: [{ id: ID, access: "owner", usable: true }] });
    expect(h.ops[0].eqs).toContainEqual(["owner_id", "u1"]);
  });
});

describe("updatePurpose: access and conflicts", () => {
  it("the owner updates; without expectedUpdatedAt there is no updated_at condition", async () => {
    h.results.select = { data: row() };
    h.results.update = { data: row({ name: "Golf 2" }) };
    expect(await updatePurpose(ID, input)).toMatchObject({ ok: true, data: { name: "Golf 2" } });
    expect(updateOp()!.eqs.map((e) => e[0])).not.toContain("updated_at");
  });

  it("a write grantee may edit", async () => {
    h.results.select = { data: row({ owner_id: "o1", purpose_shares: [{ grantee_id: "u1", access: "write" }] }) };
    h.results.update = { data: row({ owner_id: "o1", purpose_shares: [{ grantee_id: "u1", access: "write" }] }) };
    expect(await updatePurpose(ID, input)).toMatchObject({ ok: true, data: { access: "write" } });
  });

  it("a read grantee is forbidden and nothing is written; a purpose that is only on a shared trip too", async () => {
    h.results.select = { data: row({ owner_id: "o1", purpose_shares: [{ grantee_id: "u1", access: "read" }] }) };
    expect(await updatePurpose(ID, input)).toEqual({ ok: false, error: "forbidden" });
    h.results.select = { data: row({ owner_id: "o1", purpose_shares: [] }) };
    expect(await updatePurpose(ID, input)).toEqual({ ok: false, error: "forbidden" });
    expect(updateOp()).toBeUndefined();
  });

  it("an invisible purpose is not_found", async () => {
    h.results.select = { data: null };
    expect(await updatePurpose(ID, input)).toEqual({ ok: false, error: "not_found" });
  });

  it("a stale expectedUpdatedAt is a conflict before any write", async () => {
    h.results.select = { data: row() };
    expect(await updatePurpose(ID, input, "2025-01-01T00:00:00Z")).toEqual({ ok: false, error: "conflict" });
    expect(updateOp()).toBeUndefined();
  });

  it("the write is conditional on updated_at and a lost race is a conflict", async () => {
    h.results.select = { data: row() };
    h.results.update = { data: null };
    expect(await updatePurpose(ID, input, "2026-11-01T00:00:00Z")).toEqual({ ok: false, error: "conflict" });
    expect(updateOp()!.eqs).toContainEqual(["updated_at", "2026-11-01T00:00:00Z"]);
  });

  it("a policy refusal (42501) is forbidden", async () => {
    h.results.select = { data: row() };
    h.results.update = { error: { code: "42501" } };
    expect(await updatePurpose(ID, input)).toEqual({ ok: false, error: "forbidden" });
  });
});
