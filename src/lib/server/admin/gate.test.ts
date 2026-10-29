import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));
const session = vi.fn();
vi.mock("../session", () => ({ getUserSession: () => session() }));
const adminClient = vi.fn();
vi.mock("../supabase/admin", () => ({ createSupabaseAdminClient: () => adminClient() }));
vi.mock("../health", () => ({ checkDb: async () => ({ ok: true, latencyMs: 1 }) }));

import { requireAdmin } from "./gate";
import { getAdminDashboard, getHealthInfo, keyPresence } from "./stats";

function sessionWithRole(role: string | null, error: unknown = null) {
  return {
    userId: "u1",
    supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: role ? { role } : null, error }) }) }) }) },
  };
}

beforeEach(() => {
  notFound.mockClear();
  session.mockReset();
  adminClient.mockReset();
});

describe("requireAdmin", () => {
  it("lets an admin through", async () => {
    session.mockResolvedValue(sessionWithRole("admin"));
    await expect(requireAdmin()).resolves.toEqual({ userId: "u1" });
  });
  it("normal user -> 404", async () => {
    session.mockResolvedValue(sessionWithRole("user"));
    await expect(requireAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("signed out -> 404", async () => {
    session.mockResolvedValue(null);
    await expect(requireAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("missing profile or read error -> 404 (fails closed)", async () => {
    session.mockResolvedValue(sessionWithRole(null));
    await expect(requireAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
    session.mockResolvedValue(sessionWithRole("admin", { code: "x" }));
    await expect(requireAdmin()).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("admin reads are gated", () => {
  it("a non-admin never reaches the secret-key client", async () => {
    session.mockResolvedValue(sessionWithRole("user"));
    await expect(getAdminDashboard()).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(getHealthInfo()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(adminClient).not.toHaveBeenCalled();
  });
});

describe("keyPresence", () => {
  it("returns booleans only, never values", () => {
    const k = keyPresence({ ANTHROPIC_API_KEY: "sk-ant-secret", CRON_SECRET: " ", SUPABASE_SECRET_KEY: "abc" });
    expect(k.anthropicKey).toBe(true);
    expect(k.cronSecret).toBe(false);
    expect(k.aerodataboxKey).toBe(false);
    expect(JSON.stringify(k)).not.toContain("sk-ant");
    expect(Object.values(k).every((v) => typeof v === "boolean")).toBe(true);
  });
});
