import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../supabase/admin", () => ({ createSupabaseAdminClient: () => ({}) }));
vi.mock("../settings", () => ({ getEffectiveEnv: async () => ({}) }));

import { MAX_INTEREST_QUERIES } from "@/lib/facts/interest-sources";
import { GEOAPIFY_HEADROOM, STOP_LOOKUP_CREDITS } from "./geoapify-quota";

describe("Geoapify headroom (port-places section 6)", () => {
  it("covers one more in-flight stop lookup: 120 + 40 = 160", () => {
    expect(MAX_INTEREST_QUERIES).toBe(4);
    expect(STOP_LOOKUP_CREDITS).toBe(40);
    expect(GEOAPIFY_HEADROOM).toBe(160);
  });
});
