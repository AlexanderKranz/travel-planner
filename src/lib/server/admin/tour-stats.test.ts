import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { Op, Reply } from "../tour/test-db";

const h = vi.hoisted(() => ({ ops: [] as Op[], reply: ((): Reply => ({})) as (o: Op) => Reply }));
vi.mock("../supabase/admin", async () => {
  const { fakeDb } = await import("../tour/test-db");
  return { createSupabaseAdminClient: () => fakeDb("admin", h.ops, (o) => h.reply(o)) };
});

import { getTourStats } from "./tour-stats";

describe("getTourStats (admin usage: tours per week)", () => {
  it("counts tour.created and tour.computed events (head counts, no rows)", async () => {
    h.reply = (o) => ({ count: o.eqs.some(([, v]) => v === "tour.created") ? 4 : 11 });
    expect(await getTourStats(new Date("2026-11-12T12:00:00Z"))).toEqual({ created7: 4, computed7: 11 });
    expect(h.ops.every((o) => o.table === "app_events" && o.head)).toBe(true);
  });

  it("throws when a count fails (the dashboard hides the row instead of showing 0)", async () => {
    h.reply = () => ({ error: { code: "x" } });
    await expect(getTourStats()).rejects.toThrow();
  });
});
