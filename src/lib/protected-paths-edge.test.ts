import { describe, expect, it } from "vitest";
import { protectedAreaLocale } from "./protected-paths";

describe("protectedAreaLocale edge cases", () => {
  it("handles trailing slashes and deep paths", () => {
    expect(protectedAreaLocale("/de/app/")).toBe("de");
    expect(protectedAreaLocale("/en/settings/account/delete")).toBe("en");
  });
  it("does not flag look-alike segments", () => {
    expect(protectedAreaLocale("/de/apps")).toBeNull();
    expect(protectedAreaLocale("/de/settings-public")).toBeNull();
    expect(protectedAreaLocale("/de/share/app")).toBeNull();
  });

  // DEFECT (should-fix, verify in a running app): middleware tests the RAW pathname. Next.js
  // decodes percent-escapes when it routes, so /de/%61pp may reach /[locale]/app without the
  // middleware redirect. Fix: decodeURIComponent each segment (try/catch) in protectedAreaLocale,
  // and ALWAYS re-check the session in the /[locale]/app layout (defence in depth).
  it("treats percent-encoded segments like their decoded form", () => {
    expect(protectedAreaLocale("/de/%61pp")).toBe("de");
    expect(protectedAreaLocale("/de/%73ettings")).toBe("de");
  });
});
