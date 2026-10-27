import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { getDemoCredentials, isDemoEnabled } from "./demo";

const full = { DEMO_ENABLED: "true", DEMO_EMAIL: "Demo@Example.com", DEMO_PASSWORD: "pw" };

describe("isDemoEnabled", () => {
  it("is on only for exactly 'true' with email and password", () => {
    expect(isDemoEnabled(full)).toBe(true);
    for (const v of ["TRUE", "1", "yes", "false", "", undefined]) {
      expect(isDemoEnabled({ ...full, DEMO_ENABLED: v })).toBe(false);
    }
    expect(isDemoEnabled({ ...full, DEMO_EMAIL: undefined })).toBe(false);
    expect(isDemoEnabled({ ...full, DEMO_PASSWORD: "" })).toBe(false);
  });
  it("returns normalised credentials only when enabled", () => {
    expect(getDemoCredentials(full)).toEqual({ email: "demo@example.com", password: "pw" });
    expect(getDemoCredentials({ ...full, DEMO_ENABLED: "false" })).toBeNull();
  });
});
