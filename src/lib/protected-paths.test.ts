import { describe, expect, it } from "vitest";
import { protectedAreaLocale } from "./protected-paths";

describe("protectedAreaLocale", () => {
  it("flags app and settings areas", () => {
    expect(protectedAreaLocale("/de/app")).toBe("de");
    expect(protectedAreaLocale("/en/app/groups/1")).toBe("en");
    expect(protectedAreaLocale("/en/settings")).toBe("en");
  });
  it("leaves public pages alone", () => {
    expect(protectedAreaLocale("/de")).toBeNull();
    expect(protectedAreaLocale("/de/login")).toBeNull();
    expect(protectedAreaLocale("/de/application")).toBeNull();
    expect(protectedAreaLocale("/fr/app")).toBeNull();
    expect(protectedAreaLocale("/app")).toBeNull();
  });
});
