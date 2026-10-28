// QA review test: api_cache null payloads. "KNOWN DEFECT" tests use it.fails (green while the defect exists).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

const store = vi.hoisted(() => ({ upserts: [] as { payload: unknown }[] }));
vi.mock("@/lib/server/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) =>
      table === "api_cache"
        ? {
            select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
            upsert: async (row: { payload: unknown }) => {
              store.upserts.push(row);
              return { error: null };
            },
          }
        : { insert: async () => ({ error: null }) },
  }),
}));

import { cached } from "@/lib/server/api-cache";

describe("api_cache null payloads", () => {
  beforeEach(() => {
    store.upserts = [];
  });
  // api_cache.payload is `jsonb not null`. PostgREST turns a JSON null in the request body into SQL NULL,
  // so "not found" answers (Wikivoyage no page, geocoding unknown id) fail the NOT NULL check, are logged
  // as "api_cache write failed" and never cached. Fix: wrap payloads as { v: data } or store a sentinel.
  it("a legitimate `null` result is stored inside an envelope, never as payload null", async () => {
    await cached({
      provider: "wikivoyage",
      endpoint: "summary",
      key: "k",
      ttlSeconds: 60,
      schema: z.object({ a: z.string() }).nullable(),
      ctx: { userId: null },
      fetcher: async () => ({ data: null, status: 200, latencyMs: 1 }),
    });
    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0].payload).toEqual({ v: null });
  });
});

